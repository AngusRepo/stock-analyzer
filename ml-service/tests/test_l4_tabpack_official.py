"""No optimizer steps or retraining: real upstream import, data and inference."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

import numpy as np
import torch
import project.tabpack as upstream
import lib.data

from app.l4_tabpack_official import SelectedWeights, make_config, verify_source
from app.l4_tabpack_data import write_dataset
from services import l4_tabpack_weights as weights

ROOT = Path(__file__).resolve().parents[1] / 'vendor/tabpack'


class OfficialContract(unittest.TestCase):
    def test_upstream_weight_normalization_preserves_distinct_checkpoint_steps(self):
        observer = SelectedWeights()
        observer.states = {(7,1): {}, (7,2): {}, (8,1): {}}
        ensemble = SimpleNamespace(ids=np.asarray([7,7]),steps=np.asarray([1,2]),weights=np.asarray([2.,6.]))
        observer.observe_ensembles({'greedy':ensemble})
        self.assertEqual(observer.selected, [(7,1),(7,2)])
        self.assertEqual(observer.weights, [.25,.75])
        self.assertEqual(set(observer.states), {(7,1),(7,2)})

    def test_unmodified_source_and_official_default_factory(self):
        self.assertEqual(len(verify_source(ROOT)), 64)
        config = make_config(ROOT, ROOT / 'test-data')
        upstream._validate_config(config)
        self.assertEqual(config['n_models'], 64)
        self.assertEqual(config['model'], {'activation': 'ReLU', 'd_block': 384})
        self.assertEqual(config['optimizer'], {'type': 'MuonAdamWPack', 'shared_step': True})
        self.assertEqual(config['n_epochs'], -1)
        self.assertEqual(config['patience'], 16)
        self.assertEqual(config['online_ensembles']['greedy']['patience'], 32)
        self.assertEqual(config['online_ensembles']['greedy']['options']['max_ensemble_size'], 32)
        self.assertEqual(config['sampler']['space']['model']['n_blocks'], ['_tune_', 'int', 1, 4])
        self.assertEqual(config['seed'], 42)

    def test_official_dataset_loader_and_train_only_label_standardization(self):
        arrays = {name: (np.arange(102, dtype=np.float32).reshape(3, 34), np.asarray(values, np.float32))
                  for name, values in [('train', [1, 2, 3]), ('val', [101, 102, 103]), ('test', [201, 202, 203])]}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'data'
            write_dataset(path, arrays)
            config = make_config(ROOT, path)
            dataset = lib.data.build_dataset(**config['data'])
            stats = dataset.try_standardize_labels_()
            self.assertEqual(stats.mean, 2.)
            self.assertAlmostEqual(stats.std, float(arrays['train'][1].std()))
            self.assertEqual(dataset.n_num_features, 34)
            self.assertEqual(dataset.n_bin_features, 0)
            self.assertEqual(dataset.size('test'), 3)

    def test_observer_preserves_original_state_rng_and_restores_hooks(self):
        torch.manual_seed(17)
        pack = upstream.ModelPack(n_num_features=34, cat_cardinalities=[], n_classes=None,
            pack_size=2, n_blocks=[1, 4], max_n_blocks=4, d_block=384, activation='ReLU', dropout=[0., .2])
        original = upstream.StatePack(pack_size=2, configs=None)
        observed = copy.deepcopy(original)
        original.step(); observed.step()
        kwargs = {'predictions': {'val': np.zeros((2, 3))},
                  'predictions_torch': {'val': torch.zeros(2, 3)}, 'model_state_dict': pack.state_dict()}
        metrics = {'val': {'score': np.asarray([-.1, -.2])}}
        original.update(copy.deepcopy(metrics), **kwargs)
        rng = torch.get_rng_state().clone()
        hook = upstream.StatePack.update
        observer = SelectedWeights()
        with observer.installed(upstream):
            observed.update(copy.deepcopy(metrics), **kwargs)
        self.assertIs(upstream.StatePack.update, hook)
        self.assertTrue(torch.equal(rng, torch.get_rng_state()))
        np.testing.assert_array_equal(original.best_steps, observed.best_steps)
        for key in original.best_model_state_dicts:
            self.assertTrue(torch.equal(original.best_model_state_dicts[key], observed.best_model_state_dicts[key]))
        with self.assertRaisesRegex(RuntimeError, 'test'):
            with observer.installed(upstream):
                raise RuntimeError('test')
        self.assertIs(upstream.StatePack.update, hook)

    def test_full_width_depth_and_checkpoint_ensemble_export(self):
        torch.manual_seed(42)
        pack = upstream.ModelPack(n_num_features=34, cat_cardinalities=[], n_classes=None,
            pack_size=4, n_blocks=[1, 2, 3, 4], max_n_blocks=4, d_block=384, activation='ReLU', dropout=[.1] * 4)
        observer = SelectedWeights()
        # Include id 63, a repeated checkpoint, and the same id at two steps.
        keys = [(0, 1), (21, 3), (63, 7), (63, 8)]
        observer.states = {key: {k: v[i:i + 1].detach().clone() for k, v in pack.state_dict().items()}
                           for i, key in enumerate(keys)}
        observer.selected = [*keys, keys[0]]
        observer.weights = [.1, .2, .2, .3, .2]
        inputs = np.random.default_rng(5).normal(size=(127, 34)).astype(np.float32)
        members, raw, parity = observer.export(upstream, inputs)
        self.assertEqual(len(members), 4)
        self.assertAlmostEqual(members[0]['weight'], .3)
        self.assertLess(parity['max_absolute_error_standardized'], 2e-6)
        import hashlib
        sha = hashlib.sha256(raw).hexdigest()
        ref = {'path': weights.PREFIX + sha + '.npz', 'sha256': sha, 'bytes': len(raw)}
        decoded = weights.decode(raw, ref)
        weights.validate_members({'members': members}, decoded)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            weights.decode(raw[:-1], ref)
        with self.assertRaisesRegex(ValueError, 'ensemble_contract'):
            weights.validate_members({'members': [{**m, 'weight': m['weight'] * 2} for m in members]}, decoded)

    def test_train_constant_columns_are_mapped_back_without_changing_predictions(self):
        pack = upstream.ModelPack(n_num_features=3, cat_cardinalities=[], n_classes=None,
            pack_size=1, n_blocks=[2], max_n_blocks=4, d_block=384, activation='ReLU', dropout=[.1])
        observer = SelectedWeights()
        observer.states = {(42, 3): {k:v.detach().clone() for k,v in pack.state_dict().items()}}
        observer.selected, observer.weights = [(42,3)], [1.]
        inputs = np.random.default_rng(5).normal(size=(20,3)).astype(np.float32)
        members, raw, parity = observer.export(upstream,inputs,[0,16,33])
        self.assertLess(parity['max_absolute_error_standardized'], 2e-6)
        import io
        with np.load(io.BytesIO(raw)) as artifact:
            first = artifact['m0_l0_weight']
            self.assertTrue((first[[i for i in range(34) if i not in (0,16,33)]] == 0).all())


if __name__ == '__main__':
    unittest.main()
