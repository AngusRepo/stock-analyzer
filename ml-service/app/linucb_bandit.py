"""
linucb_bandit.py — LinUCB Contextual Bandit（第11個模型：自適應模型路由層）

定位：不直接預測股價，而是根據當前市場情境（context）學習「哪些 base model 在
      此情境下最可靠」，動態調整各模型的信任權重。

架構：
  Context x (d=4)：
    [0] hmm_regime_code    — HMM 市場狀態 (0=bull/1=bear/2=sideways/3=volatile)，歸一化到 [0,1]
    [1] garch_vol_norm      — GARCH 波動率，除以 0.05 clip 到 [0,2]（2% ATR 為基準）
    [2] market_risk_score   — 來自 market_env risk_score [0,1]
    [3] bias_term           — 常數 1.0（截距項，標準 LinUCB 設計）

  Arms (K=10)：
    10 個 base models，名稱對應 ModelPrediction.model_name

  Reward：
    1.0 — model 預測方向 == 5日後實際方向
    0.0 — 預測錯誤
    （線上更新：每次 auto-trade cron 收到後日驗證結果時呼叫 update()）

Algorithm（Disjoint LinUCB）：
  初始化：A_a = I_d，b_a = 0_d，α = 0.3
  選擇：UCB_a = θ_a^T x + α * sqrt(x^T A_a^{-1} x)，取最高 arm
  更新：A_a += x x^T，b_a += r * x，θ_a = A_a^{-1} b_a

持久化：以 numpy .npz 格式儲存 A/b matrices（由 model_store.py 管理路徑）

整合點：
  - ensemble.py weighted_vote() 可傳入 bandit_weights dict 修正各模型基礎權重
  - linucb_select() 回傳各 arm 的 UCB 分數，轉換為 [0,2] 的乘數疊加到原始權重
"""
import os
import json
import numpy as np
from dataclasses import dataclass, field
from typing import Optional

# ── 常數 ──────────────────────────────────────────────────────────────────────

ARM_NAMES = [
    "KalmanFilter",
    "DLinear",
    "MarkovSwitching",
    "PatchTST",
    "Chronos",
    "XGBoost",
    "CatBoost",
    "ExtraTrees",
    "LightGBM",
    "FT-Transformer",
    "DoNothing",    # 第 11 個 arm：不出手基線。混沌市場時 bandit 可選擇「不交易」
]

# DoNothing arm 的 reward 邏輯（在 main.py 處理）：
# - 市場下跌 > 摩擦成本 → reward=1（不出手是對的）
# - 市場上漲 > 摩擦成本 → reward=0（錯失機會）
DONOTHING_ARM_IDX = ARM_NAMES.index("DoNothing")

CONTEXT_DIM  = 4      # context 向量維度
NUM_ARMS     = len(ARM_NAMES)
ALPHA_EXPLORE = 0.3   # 探索係數：越大越傾向探索未知模型（靜態預設值）
MIN_OBS_TO_TRUST = 10  # 至少觀測 N 次後才信任 bandit 輸出；前期用均勻權重

# P1#10: Dynamic alpha based on win/loss streak
ALPHA_MIN = 0.1       # winning streak → exploit (low alpha)
ALPHA_MAX = 0.7       # losing streak → explore (high alpha)


def compute_dynamic_alpha(losses_5d: int = 0, total_5d: int = 0) -> float:
    """
    P1#10: Adjust LinUCB exploration based on recent trading performance.
    Losing streak → increase alpha (explore new model combinations)
    Winning streak → decrease alpha (exploit what's working)
    """
    if total_5d < 3:
        return ALPHA_EXPLORE  # not enough data, use default

    loss_rate = losses_5d / total_5d
    # Linear interpolation: loss_rate 0→ALPHA_MIN, 1→ALPHA_MAX
    alpha = ALPHA_MIN + loss_rate * (ALPHA_MAX - ALPHA_MIN)
    return round(float(np.clip(alpha, ALPHA_MIN, ALPHA_MAX)), 3)


# ── Context Builder ───────────────────────────────────────────────────────────

def build_context(
    hmm_regime: Optional[str | int] = None,   # "bull"/"bear"/"sideways"/"volatile" 或 0-3
    garch_vol:  Optional[float]     = None,    # price 單位的 GARCH 波動率（如 ATR ≈ price*0.02）
    current_price: float            = 1.0,     # 用來將 garch_vol 轉 pct
    market_risk_score: float        = 0.5,     # 0~1
) -> np.ndarray:
    """
    將市場情境轉換成 d=4 的 context 向量 x。
    所有元素均 clip 到合理範圍，避免矩陣條件數爆炸。
    """
    # [0] HMM regime code → 歸一化到 [0,1]
    regime_map = {"bull": 0.0, "bear": 1.0, "sideways": 0.5, "volatile": 0.75}
    if isinstance(hmm_regime, str):
        r = regime_map.get(hmm_regime.lower(), 0.5)
    elif isinstance(hmm_regime, (int, float)):
        r = float(hmm_regime) / 3.0  # 假設 0-3 編碼
    else:
        r = 0.5
    r = float(np.clip(r, 0.0, 1.0))

    # [1] GARCH vol pct，以 price 的 % 表示，clip 到 [0,2]（2% 為中位）
    if garch_vol is not None and current_price > 0:
        vol_pct = garch_vol / current_price
    else:
        vol_pct = 0.02   # fallback：2% 中性值
    v = float(np.clip(vol_pct / 0.05, 0.0, 2.0))   # /0.05 使 2% vol → 0.4 (不到中心)

    # [2] Market risk score [0,1]
    mrs = float(np.clip(market_risk_score, 0.0, 1.0))

    # [3] Bias term（截距）
    bias = 1.0

    return np.array([r, v, mrs, bias], dtype=np.float64)


# ── LinUCB Bandit ─────────────────────────────────────────────────────────────

@dataclass
class LinUCBBandit:
    """
    Disjoint LinUCB bandit，每個 arm 維護獨立的 A, b 矩陣。
    所有矩陣使用 float64 以保數值穩定。
    """
    d:     int   = CONTEXT_DIM
    k:     int   = NUM_ARMS
    alpha: float = ALPHA_EXPLORE

    # shape: (k, d, d) — A_a 矩陣（初始化為 Identity）
    A: np.ndarray = field(default_factory=lambda: np.stack(
        [np.eye(CONTEXT_DIM, dtype=np.float64) for _ in range(NUM_ARMS)]
    ))
    # shape: (k, d) — b_a 向量
    b: np.ndarray = field(default_factory=lambda: np.zeros(
        (NUM_ARMS, CONTEXT_DIM), dtype=np.float64
    ))
    # 每個 arm 的觀測次數，用於決定是否信任 bandit
    obs_count: np.ndarray = field(default_factory=lambda: np.zeros(NUM_ARMS, dtype=np.int32))

    def select(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """
        回傳各 arm 的 (UCB 分數, θ 估計值)。
        呼叫方可依此決定是否完全採用 bandit 選擇或僅作為權重修正。

        Returns:
            ucb_scores  shape (k,) — 各 arm 的 UCB 值（越高越建議選擇）
            theta       shape (k,) — 各 arm 的期望 reward 估計（純 exploitation）
        """
        assert x.shape == (self.d,), f"Context shape mismatch: {x.shape} != ({self.d},)"
        ucb    = np.zeros(self.k, dtype=np.float64)
        theta  = np.zeros(self.k, dtype=np.float64)

        # #15 α 動態衰減：初期高探索(0.5)，觀測充足後低探索(0.1)
        total_obs = self.total_observations()
        effective_alpha = max(0.1, 0.5 / (1.0 + total_obs / 100.0))

        for a in range(self.k):
            A_inv     = np.linalg.inv(self.A[a])
            theta_a   = A_inv @ self.b[a]
            std_a     = np.sqrt(float(x @ A_inv @ x))
            ucb[a]    = float(theta_a @ x) + effective_alpha * std_a
            theta[a]  = float(theta_a @ x)

        return ucb, theta

    def update(self, arm_idx: int, x: np.ndarray, reward: float) -> None:
        """
        觀測到 arm_idx 在 context x 下的 reward 後，更新 A, b。
        reward 應為 0 或 1（方向準確性）。
        """
        assert 0 <= arm_idx < self.k
        assert x.shape == (self.d,)
        reward = float(np.clip(reward, 0.0, 1.0))

        self.A[arm_idx]  += np.outer(x, x)
        self.b[arm_idx]  += reward * x
        self.obs_count[arm_idx] += 1

    def total_observations(self) -> int:
        return int(self.obs_count.sum())

    def is_warmed_up(self, min_obs: int = MIN_OBS_TO_TRUST) -> bool:
        """至少有 min_obs 次觀測後才認為 bandit 已收斂到可信狀態"""
        return self.total_observations() >= min_obs

    def ucb_to_weight_multipliers(
        self,
        x: np.ndarray,
        min_mult: float = 0.3,
        max_mult: float = 2.5,
        force_explore: bool = False,
    ) -> dict[str, float]:
        """
        將 UCB 分數轉換成各模型的「權重乘數」（[min_mult, max_mult] 區間）。
        若 bandit 尚未 warm-up，回傳均勻乘數 {model: 1.0}。
        供 ensemble.py weighted_vote() 使用。

        force_explore: 連續虧損時強制高探索（adaptive bandit protection）
        max_mult:      adaptive_params.bandit_max_mult，連續虧損時限制最優模型份額
        """
        if not self.is_warmed_up():
            return {name: 1.0 for name in ARM_NAMES}

        # force_explore：覆蓋 effective_alpha 為 0.5（強制探索）
        _saved_alpha = self.alpha
        if force_explore:
            self.alpha = 0.5  # 暫時覆蓋

        ucb, _ = self.select(x)

        if force_explore:
            self.alpha = _saved_alpha  # 還原
        # Min-max 歸一化到 [min_mult, max_mult]
        ucb_min, ucb_max = ucb.min(), ucb.max()
        if ucb_max - ucb_min < 1e-9:
            return {name: 1.0 for name in ARM_NAMES}
        normalized = (ucb - ucb_min) / (ucb_max - ucb_min)  # [0,1]
        multipliers = normalized * (max_mult - min_mult) + min_mult  # [min_mult, max_mult]
        return {ARM_NAMES[a]: float(multipliers[a]) for a in range(self.k)}

    def best_arm(self, x: np.ndarray) -> str:
        """回傳在 context x 下 UCB 最高的 model 名稱"""
        ucb, _ = self.select(x)
        return ARM_NAMES[int(np.argmax(ucb))]

    def stats_summary(self) -> dict:
        """用於 health endpoint 或日誌輸出"""
        _, theta = self.select(np.array([0.5, 0.4, 0.5, 1.0]))  # 中性 context
        return {
            "total_observations": self.total_observations(),
            "is_warmed_up": self.is_warmed_up(),
            "obs_per_arm": {ARM_NAMES[a]: int(self.obs_count[a]) for a in range(self.k)},
            "neutral_theta": {ARM_NAMES[a]: round(float(theta[a]), 4) for a in range(self.k)},
            "alpha": self.alpha,
        }


# ── 持久化（Load / Save）─────────────────────────────────────────────────────

BANDIT_STATE_FILENAME = "linucb_bandit_state.npz"


def save_bandit(bandit: LinUCBBandit, dir_path: str) -> str:
    """儲存 A, b, obs_count 到本地 .npz 檔 + GCS 持久化。"""
    # 本地存檔（快速存取）
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, BANDIT_STATE_FILENAME)
    np.savez(path, A=bandit.A, b=bandit.b, obs_count=bandit.obs_count,
             alpha=np.array([bandit.alpha]))
    # #3 GCS 持久化（防容器重啟遺失）
    _save_bandit_gcs(bandit)
    return path


def load_bandit(dir_path: str) -> LinUCBBandit:
    """從 GCS 載入（主）→ 本地 fallback → 全新 bandit。"""
    # #3 先嘗試 GCS
    gcs_bandit = _load_bandit_gcs()
    if gcs_bandit is not None:
        return gcs_bandit
    # 本地 fallback
    path = os.path.join(dir_path, BANDIT_STATE_FILENAME)
    if not os.path.exists(path):
        return LinUCBBandit()
    data = np.load(path)
    bandit = LinUCBBandit(
        alpha=float(data["alpha"][0]),
    )
    bandit.A         = data["A"].copy()
    bandit.b         = data["b"].copy()
    bandit.obs_count = data["obs_count"].copy()
    bandit = _migrate_bandit_arms(bandit)
    return bandit


def _migrate_bandit_arms(bandit: LinUCBBandit) -> LinUCBBandit:
    """向後兼容：舊 state 10 arms → 新 11 arms（加 DoNothing）"""
    if bandit.A.shape[0] >= NUM_ARMS:
        # 已經是新版或更大，確保 k 正確
        bandit.k = bandit.A.shape[0]
        return bandit
    old_k = bandit.A.shape[0]
    new_k = NUM_ARMS
    diff = new_k - old_k
    d = bandit.d
    # 擴展 A: 新 arms 初始化為 Identity
    new_A = np.concatenate([bandit.A, np.stack([np.eye(d, dtype=np.float64)] * diff)])
    # 擴展 b: 新 arms 初始化為零向量
    new_b = np.concatenate([bandit.b, np.zeros((diff, d), dtype=np.float64)])
    # 擴展 obs_count
    new_obs = np.concatenate([bandit.obs_count, np.zeros(diff, dtype=np.float64)])
    bandit.A = new_A
    bandit.b = new_b
    bandit.obs_count = new_obs
    bandit.k = new_k
    print(f"[LinUCB] Migrated {old_k} → {new_k} arms (added DoNothing)")
    return bandit


def _save_bandit_gcs(bandit: LinUCBBandit) -> bool:
    """#3 LinUCB GCS 持久化"""
    try:
        import io
        from .model_store import _get_bucket
        bucket = _get_bucket()
        if bucket is None:
            return False
        buf = io.BytesIO()
        np.savez(buf, A=bandit.A, b=bandit.b, obs_count=bandit.obs_count,
                 alpha=np.array([bandit.alpha]))
        buf.seek(0)
        bucket.blob("meta/linucb_bandit_state.npz").upload_from_file(
            buf, content_type="application/octet-stream")
        print("[LinUCB] saved to GCS")
        return True
    except Exception as e:
        print(f"[LinUCB] GCS save failed: {e}")
        return False


def _load_bandit_gcs() -> LinUCBBandit | None:
    """#3 從 GCS 載入 LinUCB 狀態"""
    try:
        import io
        from .model_store import _get_bucket
        bucket = _get_bucket()
        if bucket is None:
            return None
        blob = bucket.blob("meta/linucb_bandit_state.npz")
        if not blob.exists():
            return None
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        data = np.load(buf)
        bandit = LinUCBBandit(alpha=float(data["alpha"][0]))
        bandit.A         = data["A"].copy()
        bandit.b         = data["b"].copy()
        bandit.obs_count = data["obs_count"].copy()
        bandit = _migrate_bandit_arms(bandit)
        print(f"[LinUCB] loaded from GCS (obs={bandit.total_observations()}, arms={bandit.k})")
        return bandit
    except Exception as e:
        print(f"[LinUCB] GCS load failed: {e}")
        return None


# ── 主要對外介面 ──────────────────────────────────────────────────────────────

def linucb_select(
    hmm_regime: Optional[str | int],
    garch_vol:  Optional[float],
    current_price: float,
    market_risk_score: float,
    bandit: LinUCBBandit,
    adaptive_params: dict | None = None,  # 來自 KV ml:adaptive_params（T+1 自適應）
) -> dict[str, float]:
    """
    給定市場情境，回傳各 model 的 UCB 權重乘數。
    直接供 ensemble.py weighted_vote() 使用。

    adaptive_params:
      - bandit_max_mult:      上限乘數（連續虧損時縮小，預設 2.5）
      - bandit_force_explore: 強制高探索（連續虧損防 feedback loop）

    Example:
        multipliers = linucb_select("bear", garch_vol=2.5, current_price=100,
                                    market_risk_score=0.7, bandit=bandit)
        # {"KalmanFilter": 1.8, "XGBoost": 0.4, ...}
    """
    _ap = adaptive_params or {}
    max_mult      = float(_ap.get("bandit_max_mult",      2.5))
    force_explore = bool(_ap.get("bandit_force_explore", False))

    x = build_context(hmm_regime, garch_vol, current_price, market_risk_score)
    return bandit.ucb_to_weight_multipliers(x, max_mult=max_mult, force_explore=force_explore)


def linucb_update(
    hmm_regime: Optional[str | int],
    garch_vol:  Optional[float],
    current_price: float,
    market_risk_score: float,
    model_name: str,
    reward: float,         # 1.0 = 方向正確，0.0 = 方向錯誤
    bandit: LinUCBBandit,
) -> None:
    """
    接到後日驗證結果後，更新對應 arm 的 LinUCB 狀態。
    由 auto-trade cron 的「驗證流程」呼叫（未來擴充）。
    """
    if model_name not in ARM_NAMES:
        return   # 未知模型，忽略
    arm_idx = ARM_NAMES.index(model_name)
    x = build_context(hmm_regime, garch_vol, current_price, market_risk_score)
    bandit.update(arm_idx, x, reward)
