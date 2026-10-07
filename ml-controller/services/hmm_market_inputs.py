"""Single TAIEX producer; never substitute ETF or unverified legacy risk scores."""
from math import isfinite
from statistics import mean, pstdev
import json
import hashlib
from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
from services.hmm_input_contract import CONTRACT_HASH, SOURCE, checksum, validate_environment

CORE = client_proxy_for_domain(D1DataDomain.CORE)
MARKET = client_proxy_for_domain(D1DataDomain.MARKET)

def build_hmm_market_env(run_date, prices, risks, breadth=()):
    by_date = {}
    for row in prices:
        day = str(row.get("date", ""))
        value = row.get("close")
        if row.get("source") != SOURCE or day > run_date:
            raise ValueError("HMM_INPUT_CROSS_SOURCE_OR_FUTURE")
        if value is None or not isfinite(float(value)) or float(value) <= 0:
            raise ValueError("HMM_INPUT_PRICE_INVALID")
        value = float(value)
        if day in by_date and by_date[day] != value:
            raise ValueError("HMM_INPUT_DUPLICATE_CONFLICT")
        by_date[day] = value
    days = sorted(by_date)
    if not days or days[-1] != run_date:
        raise ValueError("HMM_INPUT_BENCHMARK_STALE")
    risk = {str(r["date"]): r for r in risks}
    breadth_by_date = {str(r["date"]): r for r in breadth}
    closes = [by_date[d] for d in days]
    returns = [closes[i] / closes[i-1] - 1 for i in range(1, len(closes))]
    history = {}
    for i in range(19, len(days)):
        day = days[i]
        r = risk.get(day, {})
        # No fabricated 50, zero-fill, or training on legacy incomplete scores.
        if r.get("quality_status") not in ("complete","bounded") or r.get("quality_version") != "market-risk-quality-v1" or (r.get("quality_status")=="bounded" and (r.get("quality_known_score")!=r.get("risk_score") or r.get("quality_upper_score")!=r.get("risk_score"))):
            history.clear()  # HMM transitions cannot bridge unobserved risk sessions.
            continue
        score = r.get("risk_score")
        if score is None or not isfinite(float(score)) or not 0 <= float(score) <= 100:
            history.clear()
            continue
        row = {"market_return_1d": returns[i-1], "market_return_5d": closes[i]/closes[i-5]-1,
               "market_bias_20d": closes[i]/mean(closes[i-19:i+1])-1,
               "realized_vol_3d": pstdev(returns[i-3:i]), "risk_score": float(score),
               "benchmark_source": SOURCE, "benchmark_close": closes[i],
               "risk_quality_status": "score_verified", "risk_input_quality":r.get("quality_status"), "risk_quality_checksum": r.get("quality_checksum")}
        b = breadth_by_date.get(day, {})
        # Breadth ratios have explicit units. ETF MA alignment is never stock breadth.
        if b.get("advance_ratio") is not None:
            row["advance_ratio"] = float(b["advance_ratio"])
        if b.get("bull_alignment_pct") is not None:
            row["bull_alignment_pct"] = float(b["bull_alignment_pct"]) / 100
        if r.get("vix") is not None:
            row["us_vix"] = float(r["vix"])
        history[day] = row
    env = {"hmm_input_contract": CONTRACT_HASH, "hmm_input_checksum": checksum(history),
           "requested_run_date": run_date, "market_proxy_latest_date": run_date,
           "market_proxy_symbol": "TAIEX", "market_proxy_source": SOURCE, "history": history}
    validate_environment(env)
    latest = history[run_date]
    env.update(latest)
    env.update(twii_return_1d=latest["market_return_1d"], twii_return_5d=latest["market_return_5d"],
               twii_bias_20d=latest["market_bias_20d"])
    return env

def latest_hmm_input_date(today):
    rows=CORE.query("""SELECT MAX(r.date) AS date FROM market_risk r JOIN market_risk_quality_v1 q ON r.date=q.date
        WHERE r.date<=? AND q.schema_version='market-risk-quality-v1'
        AND q.status IN ('complete','bounded') AND q.known_score=q.upper_score AND r.risk_score=q.upper_score""",[today])
    if not rows or not rows[0].get("date"):
        raise ValueError("HMM_INPUT_QUALIFIED_SESSION_MISSING")
    return rows[0]["date"]

def load_hmm_market_env(run_date):
    prices = MARKET.query("""SELECT date, close, source FROM canonical_market_index_daily
        WHERE symbol IN ('TWII','TAIEX') AND source=? AND date<=?
        ORDER BY date DESC LIMIT 1200""", [SOURCE, run_date])
    sessions=MARKET.query("SELECT session_date FROM market_trading_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 1200",[run_date])
    days=sorted({str(row["date"]) for row in prices})
    expected=sorted({str(row["session_date"]) for row in sessions})
    if not days or len(days)<39 or not expected or expected[-1]!=run_date or days[-min(len(days),len(expected)):]!=expected[-min(len(days),len(expected)):]:
        raise ValueError("HMM_INPUT_CALENDAR_GAP")
    risks = CORE.query("""SELECT r.date,r.risk_score,r.vix,q.schema_version AS quality_version,
        q.status AS quality_status,q.known_score AS quality_known_score,q.upper_score AS quality_upper_score,q.checksum AS quality_checksum,q.json AS quality_json
        FROM market_risk r JOIN market_risk_quality_v1 q ON r.date=q.date
        WHERE r.date<=? ORDER BY r.date DESC LIMIT 600""", [run_date])
    verified=[]
    for r in risks:
        raw=r.get("quality_json") or ""
        if hashlib.sha256(raw.encode()).hexdigest()!=r.get("quality_checksum"):
            continue
        quality=json.loads(raw)
        if quality.get("date")!=r.get("date") or quality.get("status") not in ("complete","bounded") or quality.get("critical_missing"):
            continue
        if quality.get("upper_score")!=r.get("risk_score") or quality.get("known_score")!=r.get("risk_score"):
            continue
        verified.append(r)
    risks=verified
    breadth = MARKET.query("""SELECT date,advance_ratio,bull_alignment_pct FROM market_breadth
        WHERE date<=? ORDER BY date DESC LIMIT 600""", [run_date])
    env=build_hmm_market_env(run_date, prices, risks, breadth)
    # usLeading dates rows by Taiwan premarket business day; require capture before 08:00 TW.
    us=MARKET.query("SELECT date,gspc_return,sox_return,created_at FROM us_market_signals WHERE date=? AND datetime(created_at)<=datetime(?) LIMIT 1",[run_date,run_date+"T00:00:00Z"])
    if us:
        for key in ("gspc_return","sox_return"):
            value=us[0].get(key)
            if value is not None and isfinite(float(value)):
                env["us_"+key]=float(value)
        env["global_return_source"]={"table":"us_market_signals","business_date":us[0]["date"],"captured_at":us[0]["created_at"],"cutoff":run_date+"T00:00:00Z"}
    return env
