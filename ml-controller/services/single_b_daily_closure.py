"""Same read-only daily Paper closure before dispatch and inside the durable job."""
from __future__ import annotations


def single_b_daily_closure(config, end_date=None):
    from services.paper_strategy_mode import single_b_policy, disabled_receipt
    from datetime import date, datetime, timezone, timedelta
    today = datetime.now(timezone(timedelta(hours=8))).date()
    business_date = end_date or today.isoformat()
    mode = single_b_policy(config, signal_date=business_date)
    if mode:
        if date.fromisoformat(business_date) > today:
            raise ValueError('paper_single_b_future_daily_closure')
        from services.l4_oof_lifecycle import L4DailyPlanPending, daily_plan_closure
        from services.d1_domain_client import client_proxy_for_domain
        nav = disabled_receipt(mode, signal_date=business_date)
        try:
            closure = daily_plan_closure(config, business_date, client_proxy_for_domain('paper'))
        except L4DailyPlanPending as exc:
            # A Paper plan is produced by the morning pipeline, not by an OOF retry.
            return {'status':'blocked','dependency_retry_required':False,'reason':str(exc),
                'expected_signal_date':business_date,'resume_after':'paper_plan_activation',
                'paired_nav_maturity':nav,'nav_retry_required':False,'promoted':False}
        return {'status':'native_l4_daily_accounted','native_l4_daily_closure':closure,
            'paired_nav_maturity':nav,'nav_retry_required':False,'promoted':False,
            'comparison_review_status':'disabled_by_single_b_policy','completion_scope':'verified_formal_paper_plan'}
    return None
