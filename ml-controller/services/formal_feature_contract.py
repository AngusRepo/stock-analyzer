"""Explicit feature identities. Legacy artifacts are never reinterpreted as 131."""
import hashlib
import json

LEGACY_SEMANTIC = "formal137-pit-asof-source-quality-v3"
FEATURE131_SEMANTIC = "formal131-without-unverified-daily-owners-v1"
PRICE131_PROFILE = "active8-release-model-profiles-v6-timexer-price131"
EXO131_PROFILE = "active8-release-model-profiles-v6-timexer-exo131"
PROFILES131 = frozenset((PRICE131_PROFILE, EXO131_PROFILE))
LEGACY_PROFILES = frozenset(("active8-release-model-profiles-v1", "active8-release-model-profiles-v2", "active8-release-model-profiles-v3", "active8-release-model-profiles-v4-timexer-price", "active8-release-model-profiles-v4-timexer-exo137"))
EXCLUDED = ('tech_limit_down_count_10', 'tech_locked_open_down_10', 'l1_sectorFlowCore', 'l1_sectorRsRatio', 'l1_sectorTurnoverShareDelta', 'tech_disposal_active')
FEATURES131 = ('l1_bbBandwidthPct', 'l1_bestFvgStrength', 'l1_bestOrderBlockStrength', 'l1_bosBullish', 'l1_brokerConcentration', 'l1_brokerNetAmount5d', 'l1_closeAboveMa60Pct', 'l1_dealerNet5d', 'l1_diTrend', 'l1_displacementPct', 'l1_eps', 'l1_foreignTrustNet5d', 'l1_macdHist', 'l1_monthlyRevenueMoM', 'l1_monthlyRevenueYoY', 'l1_return20d', 'l1_revenueGrowthYoY', 'l1_roe', 'l1_smcBullishScore', 'l1_smcNetScore', 'l1_squeezeMomentum', 'l1_squeezeRelease', 'l1_volumeExpansion20', 'l1_volumeMomentumDivergence132710', 'liq_amihud_21d', 'mom_12m_1m', 'mom_9m', 'mom_close_to_52w_high', 'mom_hl52', 'mom_ma50_200_ratio', 'mom_macd_trend_10', 'mom_reversal_1m', 'mom_reversal_6m', 'mom_rsi_14', 'mom_vol_adj_12m', 'size_log_mktcap', 'tech_adx_14', 'tech_atr_14', 'tech_bbands_pctb_20', 'tech_bbi', 'tech_bias_20', 'tech_bullish_streak_5', 'tech_cmo_14', 'tech_dma_10_50', 'tech_donchian_pos_20', 'tech_ema_12_pos', 'tech_emv_14', 'tech_gap_down', 'tech_gap_up', 'tech_granville_score', 'tech_kd9_k', 'tech_kdj_j_9', 'tech_keltner_pos_20', 'tech_limit_up_streak_10', 'tech_locked_open_up_10', 'tech_ma_convergence', 'tech_mfi_14', 'tech_mtm_10', 'tech_obv', 'tech_psy_12', 'tech_roc_10', 'tech_sar', 'tech_slow_kd_14', 'tech_sma_20_pos', 'tech_tower_3', 'tech_trix_12', 'tech_volume_ratio_5', 'tech_vr_26', 'tech_williams_r_14', 'tech_wma_10_pos', 'val_bp', 'val_dp', 'val_ep', 'val_sp', 'vol_chg_turnover_1y', 'vol_cv_volprice_20d', 'vol_money_flow_5d', 'vol_share_turnover_21d', 'vol_signal_5d', 'vola_cv_90d', 'vola_min_130d', 'vola_realized_12m', 'vola_realized_1m', 'margin_balance', 'VSTD_10', 'linear_factor', 'CNTP_20', 'RSQR_20', 'VSTD_20', 'margin_change_5d_ts', 'CNTD_20', 'RESI_5', 'foreign_5d', 'BETA_60', 'KMID', 'rsi5_dulling', 'dealer_ratio_5d', 'chip_5d', 'institutional_net', 'RESI_20', 'RESI_10', 'RSQR_60', 'vwap_bias', 'IMXD_20', 'RESI_60', 'KLEN', 'IMIN_20', 'KSFT', 'RSQR_10', 'KLOW', 'vol_ratio_20d', 'KUP', 'KUP2', 'CNTP_5', 'CORR_10', 'ma10_bias', 'CNTD_5', 'return_3d', 'volatility_5d', 'CNTN_20', 'CORD_10', 'margin_ratio', 'short_squeeze_proxy', 'volatility_20d', 'CNTN_5', 'ma60_bias', 'return_5d', 'KLOW2', 'us_sentiment_score', 'advance_ratio', 'KSFT2')
FEATURES131_SHA256 = hashlib.sha256(json.dumps(list(FEATURES131), separators=(",", ":")).encode()).hexdigest()

def feature_count(semantic=LEGACY_SEMANTIC):
    if semantic == LEGACY_SEMANTIC:
        return 137
    if semantic == FEATURE131_SEMANTIC:
        return 131
    raise ValueError("formal_feature_semantic_unknown")

def semantic_for_profile(profile):
    if profile in PROFILES131:
        return FEATURE131_SEMANTIC
    if profile in LEGACY_PROFILES:
        return LEGACY_SEMANTIC
    raise ValueError("formal_feature_profile_unknown")

def validate_feature_names(names, semantic, legacy_names):
    feature_count(semantic)
    expected = FEATURES131 if semantic == FEATURE131_SEMANTIC else tuple(legacy_names)
    if tuple(names) != expected or len(expected) != feature_count(semantic):
        raise ValueError("formal_feature_inventory_or_order_mismatch")
    return list(expected)

def prep_feature_names(semantic, legacy_names):
    feature_count(semantic)
    if semantic == LEGACY_SEMANTIC:
        return list(legacy_names)
    projected = [name for name in legacy_names if name not in EXCLUDED]
    return validate_feature_names(projected, semantic, legacy_names)

def timexer_semantic(settings):
    semantic = settings.get("feature_history_schema", LEGACY_SEMANTIC)
    feature_count(semantic)
    return semantic

def validate_profile_semantic(profile, semantic):
    if semantic_for_profile(profile) != semantic:
        raise ValueError("formal_feature_profile_semantic_mismatch")
    return semantic

def payload_semantic(payload):
    """A declared profile, release contract, snapshot and payload must agree."""
    explicit_profile = payload.get("model_profile_schema_version")
    contract_profile = (payload.get("release_training_contract") or {}).get("model_profile_schema_version")
    if explicit_profile and contract_profile and explicit_profile != contract_profile:
        raise ValueError("formal_feature_release_profile_mismatch")
    profile = explicit_profile or contract_profile
    snapshot = payload.get("dataset_snapshot") or {}
    semantic = payload.get("feature_semantic_version") or snapshot.get("feature_semantic_version") or (semantic_for_profile(profile) if profile else LEGACY_SEMANTIC)
    feature_count(semantic)
    if profile:
        validate_profile_semantic(profile, semantic)
    if snapshot.get("feature_semantic_version") and snapshot["feature_semantic_version"] != semantic:
        raise ValueError("formal_feature_snapshot_semantic_mismatch")
    return semantic

def cohort_semantic(manifest):
    return semantic_for_profile(manifest.get("model_profile_schema_version", "active8-release-model-profiles-v3"))

def metadata_feature_valid(metadata):
    semantic = metadata.get("feature_semantic_version")
    if semantic == LEGACY_SEMANTIC:
        return (metadata.get("model_training_config_attestation") or {}).get("model_profile_schema_version") not in PROFILES131
    if semantic != FEATURE131_SEMANTIC:
        return False
    attestation = metadata.get("model_training_config_attestation") or {}
    return (attestation.get("model_profile_schema_version") in PROFILES131
            and metadata.get("feature_names") == list(FEATURES131)
            and metadata.get("feature_count") == 131)


def inference_feature_sources(source, semantics):
    """Project only the approved 137->131 coordinates from one frozen capture."""
    if not semantics or not set(semantics) <= {LEGACY_SEMANTIC, FEATURE131_SEMANTIC}:
        raise ValueError("timexer_feature_history_schema_unknown")
    if not isinstance(source, dict) or source.get("schema_version") != "timexer-feature-source-v1":
        raise ValueError("timexer_frozen_feature_source_required")
    origin = source.get("feature_semantic_version", LEGACY_SEMANTIC)
    feature_count(origin)
    result = {}
    for semantic in semantics:
        if semantic == origin:
            result[semantic] = source
        elif origin == LEGACY_SEMANTIC and semantic == FEATURE131_SEMANTIC:
            result[semantic] = {"schema_version":"timexer-feature-projection-v1",
                "target_semantic":FEATURE131_SEMANTIC, "feature_names_sha256":FEATURES131_SHA256,
                "source":source}
        else:
            raise ValueError("timexer_feature_projection_reverse_forbidden")
    return {"schema_version":"timexer-feature-source-set-v1", "sources":result}
