"""Explicit, sealed stacker recipes. No recipe selection or publication here."""
from datetime import date
from copy import deepcopy

import numpy as np

from services.alpha_model_roster import validate_order
from services.active8_oof_stacker import (
    _fit_selected_ridge, _fit_ridge, _select_regularization,
    fit_qualified_prior_ridge, inner_validation_start, MODEL_WEIGHT_ZERO_TOLERANCE,
)
from services.l4_distribution import digest
from services.model_tail_validation import evaluate_tail_fold_guard
from services.l4_training_ancestry import verify_graph, check_roots
from services.training_dual_cutoff import TrainingCutoff

RECIPE_SCHEMA = 'active8-selected-stacker-recipe-v1'
QUALIFICATION_SCHEMA = 'active8-stacker-qualification-context-v1'
TREES = ('LightGBM', 'XGBoost', 'ExtraTrees')


def _sha(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def validate_recipe(recipe, order):
    order = validate_order(order)
    if (not isinstance(recipe, dict) or recipe.get('schema_version') != RECIPE_SCHEMA
            or recipe.get('recipe_checksum') != digest({k:v for k,v in recipe.items() if k != 'recipe_checksum'})
            or not all(_sha(recipe.get(k)) for k in ('source_comparison_checksum', 'selection_receipt_checksum'))):
        raise ValueError('active8_selected_recipe_unsealed')
    active = tuple(recipe.get('active_models') or ())
    if not active or active != tuple(name for name in order if name in active):
        raise ValueError('active8_selected_recipe_active_models')
    removed = set(order) - set(active)
    if (recipe.get('mode') not in ('sum_loss', 'mean_loss_causal_prior')
            or (removed and (recipe['mode'] != 'sum_loss' or len(removed) != 1 or not removed <= set(TREES)))):
        raise ValueError('active8_selected_recipe_untested_combination')
    return deepcopy(recipe)


def validate_parent_recipe(parent, recipe, order):
    sealed = parent.get('stacker_recipe')
    if sealed is None and recipe is None:
        return None
    if sealed is None or recipe is None:
        raise ValueError('native_meta_selected_recipe_required')
    requested = validate_recipe(recipe, order)
    if validate_recipe(sealed, order) != requested:
        raise ValueError('native_meta_selected_recipe_mismatch')
    return requested


class QualificationContext:
    """Verified evidence envelope; graph completeness still belongs to its producer."""
    def __init__(self, payload, order, *, require_ancestry):
        if (not isinstance(payload, dict) or payload.get('schema_version') != QUALIFICATION_SCHEMA
                or payload.get('checksum') != digest({k:v for k,v in payload.items() if k != 'checksum'})
                or not _sha(payload.get('source_manifest_checksum'))
                or set(payload.get('qualification') or {}) != set(order)
                or not isinstance(payload.get('maturity'), dict)):
            raise ValueError('active8_qualification_context_unverified')
        self.payload = deepcopy(payload)
        self.order = tuple(order)
        self.evidence = self.payload['qualification']
        self.maturity = self.payload['maturity']
        self.checksum = self.payload['checksum']
        self.nodes = verify_graph(self.payload['graph']) if self.payload.get('graph') is not None else None
        self.cutoff = TrainingCutoff(**self.payload['requested_cutoff']) if self.nodes is not None else None
        if require_ancestry and self.nodes is None:
            raise ValueError('active8_p6_qualification_ancestry_required')
        for signal, known in self.maturity.items():
            date.fromisoformat(signal); date.fromisoformat(known)
            if signal >= known:
                raise ValueError('active8_qualification_maturity_invalid')
        self._checks = {}

    def check(self, name, metric, cutoff, fold):
        if self.nodes is None:
            if fold is not None:
                raise ValueError('active8_p6_qualification_ancestry_required')
            return None
        fold_id = metric['fold_id']
        root = (self.payload.get('metric_roots', {}).get(name) or {}).get(fold_id)
        node = self.nodes.get(root) if isinstance(root, str) else None
        if not node or node.get('qualification_metric_checksum') != digest(metric):
            raise ValueError('active8_qualification_metric_root_unbound')
        cache_key = (root, cutoff, fold)
        if cache_key not in self._checks:
            # Verify declared metric support is actually in the dependency closure.
            leaves, seen = set(), set()
            def labels(key):
                if key in seen:
                    return
                seen.add(key)
                current = self.nodes.get(key) or {}
                if current.get('kind') == 'label':
                    leaves.add((current.get('date'), current.get('label_known_date')))
                for parent in current.get('parents', []):
                    labels(parent)
            labels(root)
            support = {(c['date'], self.maturity[c['date']]) for c in metric['date_cluster_ics']}
            if not support <= leaves:
                raise ValueError('active8_qualification_metric_support_unbound')
            try:
                proof = check_roots(self.nodes, [root], cutoff=self.cutoff, signal_date=cutoff, fold=fold)
                self._checks[cache_key] = dict(root=root, **proof)
            except ValueError as exc:
                if not str(exc).startswith('p6_forbidden_label_ancestor:'):
                    raise
                self._checks[cache_key] = dict(root=root, excluded_reason=str(exc))
        return self._checks[cache_key]


def prepare_qualification_context(context, order, *, required=False, excluded_label_fold=None,
                                  source_manifest_checksum=None):
    if context is None:
        if required:
            raise ValueError('active8_qualification_context_required')
        return None
    if isinstance(context, QualificationContext):
        if context.order != tuple(order) or (excluded_label_fold is not None and context.nodes is None):
            raise ValueError('active8_qualification_context_scope')
    else:
        context = QualificationContext(context, order, require_ancestry=excluded_label_fold is not None)
    if source_manifest_checksum is not None and context.payload['source_manifest_checksum'] != source_manifest_checksum:
        raise ValueError('active8_qualification_manifest_mismatch')
    return context


def ablated_fit(x, y, dates, markets, *, known, order, removed):
    """The existing P7 active-set/refit algorithm, shared with native/final fits."""
    active = tuple(m for m in order if m != removed)
    def fit(names):
        lam = _select_regularization(x, y, dates, markets, label_known_dates=known,
                                    model_order=order, active_models=names)
        w, b = _fit_ridge(x, y, lam, model_order=order, active_models=names)
        return w, b, lam
    w, b, lam = fit(active)
    selected = tuple(m for i,m in enumerate(order) if m in active and w[i] > MODEL_WEIGHT_ZERO_TOLERANCE)
    if not selected:
        return np.zeros(x.shape[1]), float(np.mean(y)), lam, selected
    if selected != active:
        w, b, lam = fit(selected)
    return w, b, lam, selected


def causal_prior(evidence, order, maturity, cutoff, *, excluded=(),
                 excluded_label_fold=None, qualification_ancestry=None):
    """Use complete mature folds; never trim clusters while retaining whole-fold IC."""
    if excluded_label_fold is not None and qualification_ancestry is None:
        raise ValueError('active8_p6_qualification_ancestry_required')
    values, details = [], {}
    for name in order:
        proof = evidence[name]
        folds, exclusions, roots = [], [], []
        for row in proof['fold_metrics']:
            clusters = row.get('date_cluster_ics') or []
            if not clusters or not all(c['date'] in maturity and maturity[c['date']] < cutoff for c in clusters):
                exclusions.append(dict(fold_id=row['fold_id'], reason='incomplete_or_unmatured'))
                continue
            if excluded_label_fold is not None and any(
                    excluded_label_fold.excludes(c['date'], maturity[c['date']]) for c in clusters):
                exclusions.append(dict(fold_id=row['fold_id'], reason='heldout_or_purge_label'))
                continue
            ancestry = qualification_ancestry.check(name, row, cutoff, excluded_label_fold) if qualification_ancestry else None
            if ancestry and ancestry.get('excluded_reason'):
                exclusions.append(dict(fold_id=row['fold_id'], reason=ancestry['excluded_reason']))
                continue
            if ancestry:
                roots.append(ancestry['root'])
            folds.append(row)
        guard = {**proof['policy']['tail_fold_guard'], 'enabled':True, 'required_for_serving_promotion':True}
        stats, failed, warnings = evaluate_tail_fold_guard(folds, guard, stage='promotion')
        eligible = bool(stats) and not failed and not warnings and name not in excluded
        values.append(float(eligible))
        details[name] = dict(folds=[r['fold_id'] for r in folds], eligible=eligible,
            failed=failed, warnings=warnings,
            label_known_max=max((maturity[c['date']] for r in folds for c in r['date_cluster_ics']), default=None))
        if qualification_ancestry is not None or excluded_label_fold is not None:
            details[name].update(excluded_folds=exclusions, metric_roots=roots)
    prior = np.asarray(values)
    if prior.sum():
        prior /= prior.sum()
    return prior, details


def fit_selected_recipe(x, y, dates, markets, *, label_known_dates, model_order,
                        recipe, cutoff_exclusive, qualification_context=None, excluded_label_fold=None):
    recipe = validate_recipe(recipe, model_order)
    date.fromisoformat(cutoff_exclusive)
    if (np.any(np.asarray(label_known_dates) >= cutoff_exclusive)
            or (excluded_label_fold is not None and any(excluded_label_fold.excludes(s,k)
                for s,k in zip(dates, label_known_dates)))):
        raise ValueError('active8_selected_recipe_forbidden_fit_labels')
    active = tuple(recipe['active_models'])
    context = prepare_qualification_context(qualification_context, model_order,
        required=recipe['mode'] == 'mean_loss_causal_prior', excluded_label_fold=excluded_label_fold)
    receipt = dict(recipe_checksum=recipe['recipe_checksum'], cutoff_exclusive=cutoff_exclusive,
        active_models=list(active), train_rows=len(y), train_dates=len(set(dates)),
        label_known_max=str(max(label_known_dates)),
        training_date_market_keys_checksum=digest(list(zip(dates.tolist(), label_known_dates.tolist(), markets.tolist()))))
    if recipe['mode'] == 'mean_loss_causal_prior':
        inner_start = inner_validation_start(dates)
        prior, proof = causal_prior(context.evidence, model_order, context.maturity, cutoff_exclusive,
            excluded_label_fold=excluded_label_fold, qualification_ancestry=context)
        # With <5 dates the existing selector returns lambda=1 without an inner fit.
        inner, inner_proof = causal_prior(context.evidence, model_order, context.maturity, inner_start,
            excluded_label_fold=excluded_label_fold, qualification_ancestry=context) if inner_start else (np.zeros(len(model_order)), None)
        w, b, lam = fit_qualified_prior_ridge(x, y, dates, markets,
            label_known_dates=label_known_dates, model_order=model_order,
            rank_prior=prior, inner_rank_prior=inner, loss_units='mean')
        selected = tuple(model_order)
        receipt.update(qualification_checksum=context.checksum, inner_validation_start=inner_start,
            prior=prior.tolist(), inner_prior=inner.tolist(),
            prior_evidence=proof, inner_prior_evidence=inner_proof)
    elif active == tuple(model_order):
        w, b, lam, selected = _fit_selected_ridge(x, y, dates, markets,
            label_known_dates=label_known_dates, model_order=model_order)
    else:
        removed = next(m for m in model_order if m not in active)
        w, b, lam, selected = ablated_fit(x, y, dates, markets,
            known=label_known_dates, order=model_order, removed=removed)
    receipt.update(regularization=float(lam), selected_models=list(selected))
    return w, b, lam, selected, receipt
