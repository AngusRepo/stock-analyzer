"""Discarded-copy regressions; all providers and model primitives stay local."""
import asyncio
from copy import deepcopy
from pathlib import Path
import subprocess
from types import ModuleType

from services import paired_nav_atomic_l2 as l2
from services import paired_nav_atomic_recommendation as recommendation
from services.paired_nav_journal import digest


class CountedList(list):
    def __init__(self, values, counts, label):
        super().__init__(values)
        self.counts, self.label = counts, label

    def __deepcopy__(self, memo):
        self.counts[self.label] = self.counts.get(self.label, 0) + 1
        result = deepcopy(list(self), memo)
        memo[id(self)] = result
        return result


def _baseline(module_name):
    # Compare against the actual clean source baseline, not a second hand-written
    # implementation. This is local Git read only; it never invokes a provider.
    repo = Path(__file__).resolve().parents[2]
    path = 'ml-controller/services/' + module_name + '.py'
    source = subprocess.check_output(['git', 'show', '65538d7b:' + path], cwd=repo, text=True)
    module = ModuleType('baseline_' + module_name)
    exec(compile(source, path, 'exec'), module.__dict__)
    return module


def test_l2_discards_no_frozen_context_copy_and_preserves_candidate_isolation(monkeypatch):
    baseline = _baseline('paired_nav_atomic_l2')
    outputs, observed_counts = [], []
    for module in (baseline, l2):
        counts = {}
        formal_payloads = [{'symbol': 'formal', 'prices': [1, 2]}]
        slates = {'a': [{'symbol': 'a', 'prices': [3, 4]}],
                  'b': [{'symbol': 'b', 'prices': [5, 6]}]}
        source = {'input_checksum': 'source', 'candidate_stocks': {'a': [], 'b': []}}
        state = {'run_date': '2026-10-15', 'screener_run_id': 1, 'active_stocks': [],
            'payloads': formal_payloads,
            'paired_nav_atomic_inputs': source,
            'paired_nav_atomic_pre_l2': {'status': 'pre_l2_payloads_built',
                'input_checksum': 'source', 'source_checksum': 'observations', 'slates': slates},
            'payload_source_observations': {'source_checksum': 'observations'},
            'pipeline_timesfm_context': {'frozen': {'value': 'unchanged'}},
            'pipeline_sequence_observations': {'series': CountedList([1, 2, 3], counts, 'sequence')}}
        formal_result = {'payloads': formal_payloads,
            'timesfm_l2_summary': {'status': 'blocked', 'reason': 'fixture gate'},
            'pipeline_sequence_observations': state['pipeline_sequence_observations'],
            'pipeline_timesfm_context': state['pipeline_timesfm_context']}
        original_sha = digest(state)
        monkeypatch.setattr(module, 'validate_daily_inputs', lambda *a, **kw: source)
        children = []

        async def enrich(child):
            # Every candidate keeps its own mutable copy. A model primitive
            # cannot mutate the frozen source, sibling, or formal payloads.
            assert child['pipeline_sequence_observations']['series'] == [1, 2, 3]
            assert child['pipeline_timesfm_context']['frozen']['value'] == 'unchanged'
            child['pipeline_sequence_observations']['series'].append(4)
            child['pipeline_timesfm_context']['frozen']['value'] = 'candidate'
            child['payloads'][0]['prices'].append(7)
            children.append(child)
            return {'payloads': child['payloads'],
                    'timesfm_l2_summary': {'status': 'blocked', 'reason': 'fixture gate'}}

        result = asyncio.run(module.prepare_atomic_l2(state, formal_result, enrich=enrich))
        assert len(children) == 2 and children[0] is not children[1]
        assert digest(state) == original_sha
        assert result['status'] == 'l2_payloads_built'
        assert result['slates']['a']['payloads'][0]['prices'] == [3, 4, 7]
        outputs.append(result)
        observed_counts.append(counts['sequence'])
    assert outputs[0] == outputs[1] and digest(outputs[0]) == digest(outputs[1])
    assert observed_counts == [3, 2], 'retain two isolated children, remove only discarded formal clone'


def test_recommendation_does_not_copy_overwritten_formal_histories(monkeypatch):
    from services import paired_nav_recommendation_path as path
    from services import recommendation_source_context as sources
    from services import screener_seed_domain_merge as seeds
    baseline = _baseline('paired_nav_atomic_recommendation')
    outputs, observed_counts = [], []
    for module in (baseline, recommendation):
        counts = {}
        own = {'screener_recs': [{'symbol': 'candidate'}],
            'predictions': {'candidate': {'score': 1}},
            'payloads': [{'symbol': 'candidate', 'prices': [3, 4]}],
            'l2_summary': {'status': 'blocked'}}
        definition = {'status': 'ready', **own, 'candidate_seed_inputs': {},
                      'persona_opinions': {'candidate': {'score': 1}}}
        prepared = {'signal_date': '2026-10-15', 'definitions': {'a': definition}}
        prepared['input_hash'] = digest(prepared)
        formal_rows = [{'symbol': 'formal'}]
        formal = {'content_checksum': 'formal-checksum', 'inputs': {
            'screener_recs': formal_rows,
            'predictions': {'formal': {'history': CountedList([1, 2], counts, 'predictions')}},
            'payloads': CountedList([{'symbol': 'formal', 'prices': [1, 2]}], counts, 'payloads'),
            'l2_summary': {'history': CountedList([1, 2], counts, 'l2_summary')},
            'filter_options': {'persona_opinions': {}, 'keep': {'value': 1}},
            'recommendation_source_context': {'source_checksum': 'source-checksum'}}}
        frozen = {'source_checksum': 'source-checksum',
            'inputs': {'candidate_recs': {'a': own['screener_recs']}, 'formal_recs': formal_rows,
                       'run_date': '2026-10-15'},
            'formal': {'status': 'captured'},
            'definitions': {'a': {'status': 'captured',
                'fundamental_quality_by_symbol': {}, 'pit_sector_alpha_by_symbol': {}}}}
        monkeypatch.setattr(path, 'replay_recommendation_context', lambda value: None)
        monkeypatch.setattr(sources, 'replay_recommendation_sources', lambda value: frozen)
        monkeypatch.setattr(seeds, 'merge_screener_seed_domains', lambda **kw: own['screener_recs'])

        def run(*, inputs):
            assert inputs['payloads'] == own['payloads']
            assert inputs['filter_options']['keep'] == {'value': 1}
            inputs['predictions']['candidate']['score'] = 2
            inputs['payloads'][0]['prices'].append(5)
            return {'recommendations': [{'symbol': 'candidate', 'score': 2}]}

        monkeypatch.setattr(path, 'run_recommendation_path', run)
        original_sha = digest([prepared, formal])
        result = module.run_atomic_recommendations(prepared=prepared,
            formal_context=formal, source_context=frozen)
        assert digest([prepared, formal]) == original_sha
        assert result['definitions']['a']['status'] == 'recommendations_materialized'
        assert result['definitions']['a']['inputs']['payloads'] == own['payloads']
        assert result['definitions']['a']['post_predictions']['candidate']['score'] == 2
        outputs.append(result)
        observed_counts.append(counts)
    assert outputs[0] == outputs[1] and digest(outputs[0]) == digest(outputs[1])
    assert observed_counts == [{'predictions': 1, 'payloads': 1, 'l2_summary': 1}, {}]
