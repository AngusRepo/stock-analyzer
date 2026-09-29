"""Close exactly the two expired September 29 Native Paper pairs with zero NAV.

Default mode is read-only. --apply requires the separately approved production
change; every target is checked before the first immutable receipt is written.
"""
import argparse
import json

from services.d1_domain_client import client_proxy_for_domain
from services.paired_nav_journal import read_snapshot
from services.paired_nav_unobserved import certify_unobserved_first_session
from services.paper_corporate_source import production_objects


TARGETS = {
    'b95d998645eaa5681fefd5e35cc566769038d22c658cea85b32b124c67717b9e':
        ('cbc28338f019b72b7938b79e413df4d85fe530abcbd026f1bef21d0cb8fa4a50', '2026-09-29'),
    'cd0eaa2d8aca42a082c94ace8c2bab2d10e0778a3879469f2a0062bb0593b66c':
        ('93a2d47b33522bb9f50cdf5c9acb8bee5710b0e55dec2996b9013dcaa7488018', '2026-09-29'),
}


class _ReadOnlyPlan(Exception):
    def __init__(self, body):
        self.body = body


def _capture_without_writing(statements):
    if len(statements) != 1 or 'paired_nav_unobserved_pairs_v1' not in statements[0][0]:
        raise ValueError('paired_nav_unobserved_unexpected_write')
    raise _ReadOnlyPlan(json.loads(statements[0][1][3]))


def run(*, query, writer, objects, apply=False):
    plans = []
    for snapshot_id, (expected_checksum, expected_date) in TARGETS.items():
        saved = read_snapshot(query, snapshot_id)
        if saved['manifest']['payload_checksum'] != expected_checksum:
            raise ValueError('paired_nav_unobserved_expected_checksum_changed')
        try:
            plan = certify_unobserved_first_session(execution_snapshot_id=snapshot_id,
                query=query, writer=_capture_without_writing, objects=objects)
        except _ReadOnlyPlan as ready:
            plan = ready.body
        if (plan['execution_payload_checksum'] != expected_checksum
                or plan['session_date'] != expected_date):
            raise ValueError('paired_nav_unobserved_target_changed')
        plans.append(plan)
    if apply:
        for plan in plans:
            certify_unobserved_first_session(execution_snapshot_id=plan['execution_snapshot_id'],
                query=query, writer=writer, objects=objects)
    return {'mode': 'apply' if apply else 'plan', 'pairs': plans,
            'nav_maturity_credit': 0, 'real_order_writes': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    learning = client_proxy_for_domain('learning')
    result = run(query=learning.query, writer=learning.batch_execute,
        objects=production_objects(), apply=args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
