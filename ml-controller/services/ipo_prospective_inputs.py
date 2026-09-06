"""Inference-only consumer of the daily, frozen eight-model challenger outputs.

Never calls an OOF builder, fits a stacker, creates a formal ensemble signal or
changes a serving pointer. Only IPO's immutable observer tables are writable.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
from scipy.stats import rankdata

from services.active8_oof_stacker import ACTIVE8_MODELS, STACKER_FEATURE_NAMES, STACKER_SEMANTIC_VERSION
from services.active8_score_semantics import MODEL_SCORE_SEMANTIC_VERSION, MODEL_TARGET_SEMANTIC_VERSION
from services.ev_lineage_contract import SCORE_SEMANTIC_VERSION, build_model_set_signature
from services.ipo_shadow import checksum, freeze_daily
from services.l4_alpha_ev_producer import _feature_value

MODE = 'frozen_stacker_prospective'
SEAL_SHA256 = '9658e55bc436cc17e10bd1a59cb4e061293cf71076bf1e4497cc6f4eb60351a0'


def load_seal() -> dict[str, Any]:
    raw = Path(__file__).with_name('ipo_existing_stacker.json').read_bytes()
    seal = json.loads(raw)
    # Canonical JSON identity survives Git's Windows/Linux line-ending handling.
    if checksum(seal) != SEAL_SHA256:
        raise ValueError('ipo_stacker_seal_checksum_mismatch')
    state = seal['state']
    if (seal['semantic_version'] != STACKER_SEMANTIC_VERSION
            or set(state['weights']) != set(STACKER_FEATURE_NAMES)
            or state['source'] != 'chronological_resolved_oof_nonnegative_ridge'
            or state['eligible_for_efficacy'] is not True
            or any(not math.isfinite(float(x)) for x in [state['intercept'], *state['weights'].values()])
            or any(float(state['weights'][name + '.rank']) < 0 for name in ACTIVE8_MODELS)):
        raise ValueError('ipo_stacker_seal_contract_invalid')
    return seal


def utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def prospective_window(day: str, now: datetime) -> bool:
    local = now.astimezone(timezone(timedelta(hours=8)))
    return (local.date().isoformat() == day and local.hour * 60 + local.minute >= 810
            or local.hour < 9 and (local.date() - timedelta(days=1)).isoformat() == day)


def stack_predictions(rows: list[dict[str, Any]], *, day: str, now: datetime,
                      seal: dict[str, Any], registry: dict[str, dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Validate full per-date universe then apply persisted weights, with no labels."""
    grouped: dict[int, dict[str, Any]] = defaultdict(dict)
    identities: dict[str, dict[str, str]] = {}
    run_ids = set()
    start = utc(day + 'T13:30:00+08:00')
    end = utc(day + 'T00:00:00+08:00') + timedelta(days=1, hours=9)
    for row in rows:
        model = str(row['model_name']).removesuffix('::challenger')
        if model not in ACTIVE8_MODELS or row['model_name'] != model + '::challenger':
            raise ValueError('ipo_unexpected_model_source')
        stock = int(row['stock_id'])
        if model in grouped[stock]:
            raise ValueError('ipo_duplicate_model_stock')
        signal = json.loads(row['model_signal']) if isinstance(row['model_signal'], str) else row['model_signal']
        generated = utc(row['generated_at'])
        if (row['prediction_date'] != day or not start <= generated < end or generated > now
                or signal.get('production_effect') is not False or signal.get('vote_weight') != 0
                or signal.get('candidate_type') != 'oof_full_fit_release'
                or signal.get('score_semantic_version') != MODEL_SCORE_SEMANTIC_VERSION
                or signal.get('target_semantic_version') != MODEL_TARGET_SEMANTIC_VERSION
                or signal.get('market_segment') not in {'LISTED', 'OTC', 'EMERGING'}):
            raise ValueError('ipo_model_time_semantic_or_authority_invalid')
        identity = {k: str(signal.get(k) or '') for k in ('artifact_id', 'artifact_version', 'artifact_checksum')}
        source = registry.get(identity['artifact_id']) or {}
        if (not identity['artifact_checksum'].startswith('sha256:') or len(identity['artifact_checksum']) != 71
                or source.get('model_name') != model or source.get('version') != identity['artifact_version']
                or source.get('checksum') != identity['artifact_checksum']
                or source.get('candidate_type') != 'oof_full_fit_release'
                or not source.get('training_run_id') or source.get('source_run_date', '') > day
                or not source.get('created_at') or utc(source['created_at']) > generated):
            raise ValueError('ipo_model_registry_identity_mismatch')
        if model in identities and identities[model] != identity:
            raise ValueError('ipo_mixed_model_artifact_universe')
        identities[model] = identity
        run_ids.add(source['training_run_id'])
        raw, rank = signal.get('raw_score'), signal.get('rank_score')
        available = row.get('availability_status') == 'observed'
        missing = row.get('missingness') or {}
        if isinstance(missing, str):
            missing = json.loads(missing)
        if not available and (model not in ACTIVE8_MODELS[5:]
                or row.get('availability_status') != 'unavailable'
                or missing.get('schema_version') != 'active8-optional-model-missingness-v1'
                or missing.get('reason') != 'active8_sequence_history_contract_unmet_optional_masked'
                or missing.get('production_effect') is not False or missing.get('vote_weight') != 0
                or not isinstance(missing.get('required_sequence_points'), int)
                or not isinstance(missing.get('available_sequence_points'), int)
                or not 0 <= missing['available_sequence_points'] < missing['required_sequence_points']
                or raw is not None or rank is not None):
            raise ValueError('ipo_model_missingness_not_attested')
        if available and (raw is None or rank is None or not math.isfinite(float(raw)) or not math.isfinite(float(rank)) or not 0 <= float(rank) <= 1):
            raise ValueError('ipo_model_score_missing_or_invalid')
        grouped[stock][model] = {**signal, 'prediction_id': row['id'], 'generated_at': row['generated_at'],
                                 'available': available, 'missingness': missing or None}
    if not grouped or set(identities) != set(ACTIVE8_MODELS) or len(run_ids) != 1:
        raise ValueError('ipo_eight_model_bundle_incomplete_or_mixed_run')
    markets: dict[str, list[int]] = defaultdict(list)
    for stock, models in grouped.items():
        if set(models) != set(ACTIVE8_MODELS) or len({x['market_segment'] for x in models.values()}) != 1:
            raise ValueError('ipo_eight_model_stock_coverage_incomplete')
        markets[models['LightGBM']['market_segment']].append(stock)
        contributors = [m for m in ACTIVE8_MODELS if models[m]['available']]
        expected = build_model_set_signature({m:identities[m]['artifact_version'] for m in contributors}, contributors)
        if any(item['model_set_signature'] != expected for item in models.values()):
            raise ValueError('ipo_rank_universe_or_signature_mismatch')
    signature = build_model_set_signature({m: i['artifact_version'] for m, i in identities.items()}, list(ACTIVE8_MODELS))
    output = {}
    state = seal['state']
    for market, stocks in markets.items():
        if len(stocks) < 3:
            raise ValueError('ipo_market_cross_section_insufficient')
        scores = np.full(len(stocks), float(state['intercept']))
        for model in ACTIVE8_MODELS:
            available_stocks = [s for s in stocks if grouped[s][model]['available']]
            values = [float(grouped[s][model]['raw_score']) for s in available_stocks]
            if available_stocks and len(available_stocks) < 3:
                raise ValueError('ipo_model_cross_section_insufficient')
            ranks = (rankdata(values, method='average') - 1) / max(1, len(available_stocks) - 1)
            rank_by_stock = dict(zip(available_stocks, ranks, strict=True))
            for stock, rank in rank_by_stock.items():
                item = grouped[stock][model]
                if abs(float(item['rank_score']) - rank) > 1e-8:
                    raise ValueError('ipo_rank_universe_or_signature_mismatch')
            # Exact existing stacker feature semantics: unavailable sequence rank
            # slot is 0.5 and its explicit availability feature is 0. This is not
            # a fabricated raw forecast, nor permission to mask core/model errors.
            x_rank = np.asarray([rank_by_stock.get(s, .5) for s in stocks])
            x_available = np.asarray([float(grouped[s][model]['available']) for s in stocks])
            scores += x_rank * float(state['weights'][model + '.rank']) + x_available * float(state['weights'][model + '.available'])
        ensemble_ranks = (rankdata(scores, method='average') - 1) / (len(stocks) - 1)
        for stock, raw, rank in zip(stocks, scores, ensemble_ranks, strict=True):
            output[stock] = {'rank': float(rank), 'raw': float(raw), 'market_segment': market,
                'model_set_signature': signature, 'models': grouped[stock], 'artifact_identities': identities,
                'training_run_id': next(iter(run_ids))}
    return output


def _query_inputs(clients: dict[str, Any], day: str) -> tuple[list[dict], list[dict], dict[str, dict]]:
    learning, core, ops = (clients[k] for k in ('learning', 'core', 'ops'))
    heads = ops.query('SELECT run_id FROM canonical_run_heads WHERE logical_run_key=?',
                      [f'screener:{day}:TW:production:market_screener'])
    if len(heads) != 1:
        raise ValueError('ipo_canonical_screener_head_missing')
    references = learning.query('''SELECT symbol,score_components,producer_run_id,feature_available,
        feature_rejection_reason FROM selection_reference_snapshots_v1
        WHERE signal_date=? AND producer_run_id=?''', [day, heads[0]['run_id']])
    by_symbol = {r['symbol']: r for r in references}
    if len(by_symbol) != len(references):
        raise ValueError('ipo_reference_duplicate_symbol')
    candidates = core.query('SELECT stock_id,symbol,alpha_context FROM daily_recommendations WHERE date=? ORDER BY stock_id', [day])
    if not candidates or any(r['symbol'] not in by_symbol for r in candidates):
        raise ValueError('ipo_canonical_reference_coverage_incomplete')
    candidates = [{**r, **by_symbol[r['symbol']], 'recommendation_date': day} for r in candidates]
    rows = learning.query('''SELECT id,stock_id,model_name,generated_at,prediction_date,
        json_extract(forecast_data,'$.model_signal') AS model_signal,
        json_extract(forecast_data,'$.missingness') AS missingness,
        json_extract(forecast_data,'$.availability_status') AS availability_status
        FROM predictions WHERE prediction_date=? AND model_name LIKE '%::challenger'
        ORDER BY id''', [day])
    ids = sorted({(json.loads(r['model_signal']) if isinstance(r['model_signal'], str) else r['model_signal']).get('artifact_id')
                  for r in rows if r.get('model_signal')})
    if not ids:
        raise ValueError('ipo_eight_model_predictions_missing')
    if len(ids) != 8:
        raise ValueError('ipo_eight_model_registry_set_invalid')
    registry = learning.query('''SELECT artifact_id,model_name,version,checksum,candidate_type,
        training_run_id,source_run_date,created_at FROM model_artifact_registry WHERE artifact_id IN ('''
        + ','.join('?' for _ in ids) + ')', ids)
    return candidates, rows, {r['artifact_id']: r for r in registry}


def _load_context(clients: dict[str, Any], candidates: list[dict], day: str, cutoff: str) -> tuple[dict, dict, dict]:
    from services.active8_oof_cohort_materializer import load_fundamental_quality_pit_by_key
    from services.pit_sector_alpha import load_pit_sector_alpha_experts
    from services.fusion_market_context import load_pit_market_contexts, normalize_market_context, merge_market_context
    market = clients['market'].query
    fundamentals = load_fundamental_quality_pit_by_key(
        [{'prediction_date': day, 'symbol': r['symbol']} for r in candidates], query_fn=market)
    sector = load_pit_sector_alpha_experts(market, core_query_fn=clients['core'].query,
        signal_date=day, symbols=[r['symbol'] for r in candidates], knowledge_cutoff=cutoff)
    contexts = load_pit_market_contexts(market, [day], core_query_fn=clients['core'].query)
    regime_rows = market('''SELECT run_date,state_json,state_checksum,computed_at,persisted_at
        FROM market_regime_state_history_v1 WHERE run_date=?''', [day])
    regime = verify_regime(regime_rows, day=day, cutoff=cutoff)
    for key, context in list(contexts.items()):
        recorded = normalize_market_context({'source_date': day, 'source': 'market_regime_state_history_v1',
            'regime_surface': regime['regime_surface'], 'market_segment': key[1],
            'source_lineage': {'state_checksum': regime_rows[0]['state_checksum'], 'computed_at':regime['computed_at']}}, signal_date=day)
        contexts[key] = merge_market_context(recorded, context, signal_date=day)
    return fundamentals, sector, contexts


def verify_regime(rows: list[dict], *, day: str, cutoff: str) -> dict:
    if len(rows) != 1:
        raise ValueError('ipo_regime_history_missing')
    record = rows[0]
    raw = record['state_json']
    if hashlib.sha256(raw.encode()).hexdigest() != record['state_checksum']:
        raise ValueError('ipo_regime_history_checksum_mismatch')
    value = json.loads(raw)
    surface = value.get('regime_surface') or {}
    if (value.get('schema_version') != 'market-regime-state-v1' or value.get('run_date') != day
            or record.get('run_date') != day or value.get('source') != 'hmm'
            or value.get('computed_at') != record.get('computed_at')
            or not record.get('persisted_at') or utc(record['persisted_at']) > utc(cutoff)
            or utc(value['computed_at']) > utc(cutoff) or not surface
            or any(not math.isfinite(float(v)) or float(v) < 0 for v in surface.values())
            or not math.isclose(sum(float(v) for v in surface.values()), 1., abs_tol=1e-6)):
        raise ValueError('ipo_regime_history_time_or_semantic_invalid')
    return value


def _load_l4(seal: dict) -> dict:
    from google.cloud import storage
    from services.expected_return_candidate_forward_evaluator import _load_candidate_packet
    return _load_candidate_packet(storage.Client().bucket('stockvision-models'), seal['l4_comparator'])


def collect_prospective_daily(*, signal_date: str, source_run_id: str, clients: dict[str, Any],
                               dry_run: bool = False) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    seal = load_seal()
    base = {'signal_date': signal_date, 'observed_at': now.isoformat(), 'input_mode': MODE,
            'production_effect': False, 'promotion_allowed': False, 'training_dispatched': False,
            'rows': 0, 'stacker_seal_checksum': SEAL_SHA256}
    if not dry_run and (signal_date < seal['first_prospective_signal_date'] or not prospective_window(signal_date, now)):
        return {**base, 'status': 'historical_not_prospective', 'blockers': []}
    try:
        candidates, sources, registry = _query_inputs(clients, signal_date)
        base['candidate_rows'] = len(candidates)
        stacked = stack_predictions(sources, day=signal_date, now=now, seal=seal, registry=registry)
        if {int(r['stock_id']) for r in candidates} != set(stacked) or len(candidates) != len(stacked):
            raise ValueError('ipo_full_candidate_universe_mismatch')
        cutoff = max(utc(r['generated_at']) for r in sources).isoformat()
        fundamentals, sectors, contexts = _load_context(clients, candidates, signal_date, cutoff)
        l4 = _load_l4(seal)
        label_max = str((l4['artifact'].get('training_data') or {}).get('label_known_max_date') or '')
        if not label_max or label_max >= signal_date:
            raise ValueError('ipo_l4_training_label_cutoff_invalid')
        from services.expected_return_candidate_forward_evaluator import _l4_prediction
        from services.fusion_market_context import context_for_market_segment
        rows, blockers = [], Counter()
        for row in candidates:
            symbol, stock = row['symbol'], int(row['stock_id'])
            ml = stacked[stock]
            if row.get('feature_available') != 1 or row.get('feature_rejection_reason'):
                blockers['canonical_reference_features_unavailable'] += 1
                continue
            fundamental = fundamentals.get((signal_date, symbol))
            if not fundamental or fundamental.get('score') is None:
                blockers['fundamental_pit_source_missing'] += 1
                continue
            payload = json.loads(row['score_components']) if isinstance(row['score_components'], str) else row['score_components']
            components = dict((payload or {}).get('components') or {})
            if payload.get('version') != 'score_v2' or any(components.get(k) is None or not math.isfinite(float(components[k]))
                or not 0 <= float(components[k]) <= 25 for k in ('chipFlow', 'technicalStructure')):
                blockers['canonical_non_ml_score_invalid'] += 1
                continue
            components.update(mlEdge=round(ml['rank'] * 25, 6), fundamentalQuality=round(float(fundamental['score']), 6), newsTheme=0)
            score = {**payload, 'components': components, 'semanticVersion': SCORE_SEMANTIC_VERSION}
            prediction = {'ensemble_v2': {'avg_rank': ml['rank'], 'generation_mode': MODE,
                'semantic_version': STACKER_SEMANTIC_VERSION, 'production_effect': False}}
            expert = sectors.get(symbol)
            if not expert:
                blockers['sector_pit_source_missing'] += 1
                continue
            # Explicit availability indicators retain L4's existing missing-sector
            # semantics; never replace its 19-feature model with the IPO's four.
            alpha = {'pit_sector_alpha_expert': expert, 'market_regime_context': context_for_market_segment(
                contexts, signal_date=signal_date, market_segment=ml['market_segment'])}
            enriched = {**row, 'prediction_date': signal_date, 'score_components': score, 'alpha_context': alpha}
            features = {n: _feature_value(n, enriched, prediction) for n in l4['artifact']['feature_names']}
            if any(v is None or not math.isfinite(v) for v in features.values()):
                blockers['l4_full_feature_set_missing'] += 1
                continue
            ev = _l4_prediction({'features': features}, l4['artifact'])
            provenance = {'schema_version': 'ipo-prospective-input-v1', 'mode': MODE,
                'stacker_seal_checksum': SEAL_SHA256, 'prediction_date': signal_date,
                'source_run_id': source_run_id, 'canonical_run_id': row['producer_run_id'],
                'model_training_run_id': ml['training_run_id'], 'model_outputs': ml['models'],
                'model_artifact_identities': ml['artifact_identities'], 'stacker_raw': ml['raw'],
                'stacker_rank': ml['rank'], 'fundamental_pit': fundamental,
                'score_components_checksum': checksum(payload), 'l4_full_features': features,
                'l4_context': alpha, 'l4_packet_checksum': l4['checksum'],
                'production_effect': False, 'training_dispatched': False}
            rows.append({'row': enriched, 'prediction': prediction, 'generation_mode': MODE,
                'model_set_signature': ml['model_set_signature'], 'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION,
                'input_provenance': provenance, 'l4_payload': {'expected_return_mean': ev,
                    'artifact_id': seal['l4_comparator']['artifact_id'], 'features': features, 'production_effect': False}})
        base.update(eligible_rows=len(rows), rejection_counts=dict(blockers), source_model_rows=len(sources),
                    optional_model_missing_rows=sum(not v['available'] for s in stacked.values() for v in s['models'].values()),
                    model_set_signature=next(iter(stacked.values()))['model_set_signature'],
                    l4_comparator=seal['l4_comparator']['artifact_id'],
                    sector_available_rows=sum(r.get('status') == 'loaded' for r in sectors.values()))
        if blockers or not rows:
            return {**base, 'status': 'awaiting_shadow_inputs', 'blockers': sorted(blockers) or ['no_candidates']}
        if dry_run:
            return {**base, 'status': 'ready_to_freeze', 'blockers': [], 'prospective_credit': False}
        result = freeze_daily(snapshot_date=signal_date, source_run_id=source_run_id, rows=rows,
                              query=clients['learning'].query, writer=clients['learning'].batch_execute)
        return {**base, **result, 'blockers': []}
    except ValueError as exc:
        return {**base, 'status': 'awaiting_shadow_inputs', 'eligible_rows': 0, 'blockers': [str(exc)]}
