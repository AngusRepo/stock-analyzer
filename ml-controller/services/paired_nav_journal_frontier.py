"""Bind publication to original verified family journals, not a return gate."""
from services.paired_nav_journal import encode


def journal_frontier_guard(nav):
    # Called only with the original read_nav_candidate_decision result. Its
    # checksum/family census already comes from the verified immutable review.
    frontier = nav.get('review_family_journal_frontier')
    if not isinstance(frontier, list) or not frontier:
        raise ValueError('active8_nav_journal_frontier_missing')
    # No business-date filter: a later accounting day must invalidate a stale
    # export too. One bound JSON value avoids per-member placeholder limits.
    return ("""SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM json_each(?) f WHERE
          (SELECT COUNT(*) FROM paired_nav_daily_journal_v1 j
            WHERE j.pair_id=json_extract(f.value,'$.pair_id'))
            != json_extract(f.value,'$.accounted_sessions')
          OR (SELECT session_date FROM paired_nav_daily_journal_v1 j
            WHERE j.pair_id=json_extract(f.value,'$.pair_id') ORDER BY session_date DESC LIMIT 1)
            IS NOT json_extract(f.value,'$.last_session_date')
          OR (SELECT payload_checksum FROM paired_nav_daily_journal_v1 j
            WHERE j.pair_id=json_extract(f.value,'$.pair_id') ORDER BY session_date DESC LIMIT 1)
            IS NOT json_extract(f.value,'$.last_journal_checksum')
        ) THEN 1 ELSE json('active8_nav_journal_frontier_changed') END AS nav_journal_stable""",
        [encode(frontier)])
