"""Run upstream main unchanged; observe selected checkpoints for deployment.

This module runs in a dedicated NumPy 2/Python 3.12 process. Hooks only copy
state after upstream updates; they do not change losses, RNG, or selection.
"""
from contextlib import contextmanager
import hashlib
import importlib.util
import io
import json
from pathlib import Path

from .l4_tabpack_protocol import SEED, UPSTREAM_COMMIT
from services.l4_tabpack_budget_protocol import LEGACY_RECIPE, RECIPE, configure, validate_run


def verify_source(root):
    root = Path(root)
    manifest = json.loads((root / 'UPSTREAM.json').read_text())
    if manifest['commit'] != UPSTREAM_COMMIT:
        raise ValueError('tabpack_upstream_revision_mismatch')
    for name, sha in manifest['files'].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != sha:
            raise ValueError('tabpack_upstream_source_modified:' + name)
    return hashlib.sha256((root / 'UPSTREAM.json').read_bytes()).hexdigest()


def make_config(root, dataset, *, recipe=LEGACY_RECIPE, seed=SEED):
    validate_run(recipe, seed)
    import lib.config
    spec = importlib.util.spec_from_file_location('tabpack_official_config', Path(root) / 'experiments/tabpack/make.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    data_fn, batch_fn = lib.config.make_data_config, lib.config.get_batch_size
    try:
        # Only register our already-normalized, all-numeric finance dataset.
        lib.config.make_data_config = lambda *a, **k: {'path': str(Path(dataset).resolve()),
            'extract_bin_from_num': False, 'num_policy': None, 'cache': False}
        lib.config.get_batch_size = lambda _: 1024
        return configure(module.make_config('stockvision', seed=seed), recipe=recipe, seed=seed)
    finally:
        lib.config.make_data_config, lib.config.get_batch_size = data_fn, batch_fn


class SelectedWeights:
    def __init__(self):
        self.states, self.latest, self.best, self.selected = {}, {}, {}, []
        self.weights = []

    def observe_state(self, state, current):
        for i, mid in enumerate(state.ids):
            mid = int(mid)
            for step, values, index in ((int(state.steps[i]), current, self.latest),
                                        (int(state.best_steps[i]), state.best_model_state_dicts, self.best)):
                key = (mid, step)
                index[mid] = key
                if key not in self.states:
                    self.states[key] = {name: value[i:i + 1].detach().cpu().clone() for name, value in values.items()}

    def observe_ensembles(self, ensembles):
        import numpy as np
        ensemble = ensembles['greedy']
        selected = [(int(i), int(s)) for i, s in zip(ensemble.ids, ensemble.steps, strict=True)]
        if selected:
            if any(key not in self.states for key in selected):
                raise ValueError('tabpack_selected_checkpoint_missing')
            self.selected = selected
            raw = np.ones(len(selected)) if ensemble.weights is None else np.asarray(ensemble.weights, np.float64)
            self.weights = (raw / raw.sum()).tolist()
        retain = set(self.selected) | set(self.latest.values()) | set(self.best.values())
        self.states = {k: v for k, v in self.states.items() if k in retain}

    @contextmanager
    def installed(self, upstream):
        update, ensemble_update = upstream.StatePack.update, upstream.update_online_ensembles
        observer = self
        def observed_update(state, *args, **kwargs):
            result = update(state, *args, **kwargs)
            observer.observe_state(state, kwargs['model_state_dict'])
            return result
        def observed_ensembles(ensembles, **kwargs):
            result = ensemble_update(ensembles, **kwargs)
            observer.observe_ensembles(ensembles)
            return result
        upstream.StatePack.update, upstream.update_online_ensembles = observed_update, observed_ensembles
        try:
            yield self
        finally:
            upstream.StatePack.update, upstream.update_online_ensembles = update, ensemble_update

    def export(self, upstream, inputs, feature_indices=None):
        import numpy as np
        import torch
        from services.l4_tabpack_weights import infer, validate_members
        feature_indices = list(range(34)) if feature_indices is None else list(feature_indices)
        if inputs.shape[1] != len(feature_indices) or not feature_indices:
            raise ValueError('tabpack_feature_mapping_invalid')
        arrays, members = {}, []
        expected = np.zeros(len(inputs), np.float64)
        # Greedy may select one checkpoint more than once. Merge its weight,
        # while keeping the same model at different steps as distinct members.
        unique = {}
        for key, weight in zip(self.selected, self.weights, strict=True):
            unique[key] = unique.get(key, 0.) + weight
        for i, ((mid, step), weight) in enumerate(unique.items()):
            state = self.states[(mid, step)]
            depth = int(state['backbone.n_blocks'].item())
            members.append({'member_id': mid, 'step': step, 'depth': depth, 'weight': float(weight)})
            for j, name in enumerate([f'backbone.blocks.{b}.linear' for b in range(depth)] + ['output']):
                value = state[name + '.weight'][0].float().numpy().T.copy()
                if j == 0:
                    # Upstream drops train-constant columns. Map the trained
                    # coordinates back to the stable 34-input serving contract.
                    expanded = np.zeros((34, 384), np.float32)
                    expanded[feature_indices] = value
                    value = expanded
                arrays[f'm{i}_l{j}_weight'] = value
                arrays[f'm{i}_l{j}_bias'] = state[name + '.bias'][0].float().numpy().reshape(-1).copy()
            # Rebuild the exact official masked pack, including inactive layers.
            # fork_rng prevents parity verification from consuming training RNG.
            with torch.random.fork_rng(devices=[]):
                model = upstream.ModelPack(n_num_features=len(feature_indices), cat_cardinalities=[], n_classes=None,
                    pack_size=1, n_blocks=[depth], max_n_blocks=4, d_block=384, activation='ReLU', dropout=[0.])
            model.load_state_dict(state, strict=True)
            model.eval()
            with torch.no_grad():
                for start in range(0, len(inputs), 1024):
                    expected[start:start + 1024] += weight * model(torch.from_numpy(inputs[start:start + 1024]), None)[0, :, 0].double().numpy()
        validate_members({'members': members}, arrays)
        full_inputs = np.zeros((len(inputs), 34), np.float32)
        full_inputs[:, feature_indices] = inputs
        actual = infer(full_inputs, members, arrays)
        error = float(np.max(np.abs(actual - expected)))
        if not np.allclose(actual, expected, rtol=2e-5, atol=2e-6):
            raise ValueError('tabpack_official_export_parity_failed')
        buffer = io.BytesIO()
        np.savez_compressed(buffer, **arrays)
        return members, buffer.getvalue(), {'rows': len(inputs), 'max_absolute_error_standardized': error,
                                            'rtol': 2e-5, 'atol': 2e-6, 'reference': 'official_ModelPack_FP32'}


def run(root, dataset, output, *, recipe=LEGACY_RECIPE, seed=SEED):
    import numpy as np
    import lib.data
    import lib.experiment
    import lib.utils
    import project.tabpack as upstream
    root, output = Path(root).resolve(), Path(output).resolve()
    source_sha = verify_source(root)
    config = make_config(root, dataset, recipe=recipe, seed=seed)
    lib.utils.init()
    unprocessed = lib.data.load_data(dataset, ('default',))['x_num']['train']
    feature_indices = np.flatnonzero((unprocessed != unprocessed[0]).any(axis=0)).tolist()
    if not feature_indices:
        raise ValueError('tabpack_all_training_features_constant')
    experiment = lib.experiment.create(output / 'experiment', config=config, parents=True)
    observer = SelectedWeights()
    with observer.installed(upstream):
        report = lib.experiment.run(upstream.main, None, experiment)
    if not lib.experiment.is_done(experiment) or not observer.selected:
        raise ValueError('tabpack_official_training_incomplete')
    # No post-selection refit or test-return-based seed choice.
    data = lib.data.build_dataset(**config['data'])
    stats = data.try_standardize_labels_()
    inputs = np.concatenate([data.data['x_num'][p] for p in ('train', 'val', 'test')])
    members, raw, parity = observer.export(upstream, inputs, feature_indices)
    (output / 'weights.npz').write_bytes(raw)
    result = {'members': members, 'residual_mean': stats.mean, 'residual_scale': stats.std,
              'config': config, 'upstream_manifest_sha256': source_sha, 'report': report,
              'export_verification': parity, 'retained_feature_indices': feature_indices,
              'seed': seed, 'training_recipe': recipe, 'training_completed': True,
              'configuration_overrides': {'n_models': 16} if recipe == RECIPE else {},
              'checkpoint_sha256': hashlib.sha256(raw).hexdigest()}
    (output / 'result.json').write_text(json.dumps(result, sort_keys=True, allow_nan=False), encoding='utf-8')
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--dataset', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--recipe', default=LEGACY_RECIPE)
    parser.add_argument('--seed', type=int, default=SEED)
    args = parser.parse_args()
    run(args.root, args.dataset, args.output, recipe=args.recipe, seed=args.seed)
