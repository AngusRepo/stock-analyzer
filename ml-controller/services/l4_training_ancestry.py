"""Validate the declared label dependency closure before any P6 fold is fitted.

The graph is emitted by the checkpoint/meta materializer, not inferred from
OOF filenames. Its completeness still requires producer/source receipts.
"""
from dataclasses import dataclass
from datetime import date
from services.l4_distribution import digest


@dataclass(frozen=True)
class HeldoutFold:
    first: str
    last: str
    purge_dates: frozenset[str]

    def excludes(self, signal, known):
        if not signal or not known or signal >= known:
            raise ValueError('p6_invalid_label_interval')
        return signal in self.purge_dates or signal <= self.last and known >= self.first


def verify_graph(graph):
    if (graph.get('schema_version') != 'l4-training-ancestry-v1'
            or graph.get('checksum') != digest({k:v for k,v in graph.items() if k!='checksum'})
            or not graph.get('producer_source_sha256') or not graph.get('source_receipts')):
        raise ValueError('p6_ancestry_graph_unverified')
    for sha in [graph['producer_source_sha256'], *graph['source_receipts']]:
        if len(sha)!=64 or any(c not in '0123456789abcdef' for c in sha):
            raise ValueError('p6_ancestry_source_checksum_invalid')
    return graph['nodes']


def check_roots(nodes, roots, *, cutoff, signal_date, fold=None):
    if not roots: raise ValueError('p6_feature_roots_missing')
    visiting,visited,labels=set(),set(),set()
    def visit(key):
        if key in visiting: raise ValueError('p6_ancestry_cycle:'+key)
        if key in visited:return
        node=nodes.get(key)
        if not isinstance(node,dict) or node.get('complete') is not True or not isinstance(node.get('parents'),list):
            raise ValueError('p6_ancestry_incomplete:'+key)
        visiting.add(key)
        kind=node.get('kind')
        if kind=='label':
            s,k=node['date'],node['label_known_date']
            date.fromisoformat(s);date.fromisoformat(k)
            if node['parents'] or not cutoff.admits(s,k) or k>=signal_date or (fold and fold.excludes(s,k)):
                raise ValueError('p6_forbidden_label_ancestor:'+key)
            labels.add(key)
        elif kind=='derived':
            if not node['parents']:raise ValueError('p6_derived_dependencies_missing:'+key)
        elif kind=='exogenous':
            if node['parents'] or node.get('label_free') is not True:
                raise ValueError('p6_label_free_unverified:'+key)
        else:raise ValueError('p6_ancestry_kind_invalid:'+key)
        for parent in node['parents']:visit(parent)
        visiting.remove(key);visited.add(key)
    for root in roots:visit(root)
    return dict(visited_nodes=len(visited),label_leaves=len(labels),forbidden_label_ancestors=0)
