# Fusion v13 lineage closure findings

## Production truth (2026-08-07)

- Serving state 是 fail-closed：`expected_return_owner=null`、`action_gate=fusion_primary_required`，沒有 bypass。
- Fusion 現役 champion 是 `allocator-ev-fusion-abstention-baseline-v1`，artifact contract v12；目前 candidate 是 v13，因此出現 contract/head/model incompatible blockers。
- L4 現役 champion 是 contract v4 safe-abstention baseline；最新 L4 candidate 同為 v4，但 offline gate 未通過。
- 8/7 01:55 後的新 frozen-forward packet 已推進到 OOF max 2026-07-30；Fusion/L4 都取得 513 sector samples / 1 legal PIT date，證明 lineage automation 已正常銜接第一個合法日期。

## Quality evidence

- Fusion shadow：18,133 validation samples / 29 dates；sector 0/0；selection OOS 3,791 / 7 dates。
- Fusion selection corr LCB90 `-0.10856412`、spread LCB90 `-0.02556274`；對 L4 僅 7 paired dates，spread delta LCB90 `-0.00062365`。
- Conditional execution OOS corr/spread LCB90 都為負，walk-forward 未通過。
- Execution probability Brier/log-loss 都差於 climatology，AUC `0.416435`。
- L4：23,078 samples / 39 dates；sector 0/0；date-cluster corr/spread LCB90 都為負；walk-forward 只有 1/4 正窗。
- 因此目前 forecast/economic blockers 是真實品質失敗，不應放寬門檻。

## Sector lineage root cause

- Native sector snapshots 並非缺資料：2026-07-30 為 246/246 loaded，2026-08-06 為 125/125 loaded。
- 舊 `sector_flow` 多數 row 沒有 `pit_lineage_version`；`sector-flow-pit-v1` 自 2026-07-22 起才存在，部分歷史 row 在 2026-07-30 才建立，不能回填到較早 decision cutoff。
- 2026-07-30 的 sector source 在該日 canonical screener rerun 前可得，且已由 8/7 post-close frozen-forward materialization 驗證為第一個合法 PIT sector date；不需等下一個 evening chain。
- `sector_samples=0` 的舊畫面不是「L4 大量成熟樣本永遠沒有 sector」，而是舊 packet 的 OOF max 只到 7/29；UI 必須同時顯示 packet business date 與 OOF max，避免把 freshness 誤讀成 coverage bug。

## Evidence presentation bugs

- `pipelineDecisionMaturity.ts` 把 7/28 serving champion、8/2 offline candidate、8/6 shadow packet 的 blockers/metrics/date 混在同一張卡。
- reader 仍讀舊欄位 `s12_structure_*`、`walk_forward`、`execution_model`；v13 writer 已改成 selection diagnostics、conditional execution return 與 execution probability experts。
- raw blocker 串直接顯示，導致 abstention baseline 的 safety role 被誤解為 candidate quality failure。
- frozen-forward router 原本把真實 validation `decision` 一律覆寫成 `FAIL`，並把 `frozen_forward_oos_shadow_only` 塞進 `failed_gates`；這使 quality 與 policy 永遠混在一起。修正後 quality decision 保持原值，shadow-only 只寫入獨立 monitoring policy。

## Replay lifecycle bug

- 2026-07-30 S12 research replay 已到 572 rows，state 正確進入 `replay_pending_maturity`；但 7/31 之後的 lifecycle rows 仍長時間顯示 `replay_rows=0`，證實 chunk progress sticky telemetry 尚未修復。
- root cause：orchestrator 只在 terminal/wait branch 寫 replay coverage；每個成功 chunk 在 `hasMore=true` 時不更新 progress。
- shared research lease 有效阻止同時執行，但 delayed retries 造成重複 waiting telemetry；需讓每個成功 chunk 單調回寫 progress，terminal 狀態仍只由完整 coverage 決定。

## v13 baseline design

- 現役 Fusion baseline 的 v12 contract 與 v13 challenger 不同，確實不是可接受的現役 control；不能只改 UI 文案。
- 新 baseline 使用 v13 artifact contract、相同 feature/label semantic、相同兩個 policy-value heads；兩個 head 都是明確常數零的 no-trade control，沒有第三個 selection serving head。
- operational safety 與統計 claim 分離：baseline validation 只 PASS `operational_safety_only`，`alpha_quality_passed=false`、`primary_expected_return_allowed=false`。
- challenger 的經濟比較有兩個不同問題：`Final top trade EV LCB90 > 0` 是在同一 OOF date panel 對 no-trade baseline；paired champion comparison 則對 canonical L4。兩者都要通過，不能互相代替。
- serving evaluator 應先驗證 baseline 的 v13 contract/head/zero-control 結構，再只回報 `abstention_baseline_not_serving`；不應再顯示 head missing、contract incompatible 等假 blocker。

## Implemented closure

- 新增 legacy D1 `0104` 與 learning D1 `0004` migration；只在 pointer 仍指向 v12 abstention baseline 時切到 v13，不覆蓋任何真 alpha champion。
- v13 baseline payload 以 canonical JSON + SHA-256 綁定，兩個 zero-control heads 與 challenger contract/feature/label 完全一致。
- Fusion builder 新增同 OOF panel 的 v13 no-trade comparison packet；`top trade EV LCB90 > 0` 與 paired canonical L4 comparison 分開。
- maturity API/UI 新增 serving control、offline candidate、frozen-forward shadow 三個 evidence scopes；舊 v13 JSON path drift 與 S12 structure 殘留欄位已移除。
- replay orchestrator 每個成功 chunk 都查實際 coverage 並單調回寫 lifecycle，不再只在 terminal branch 更新。
