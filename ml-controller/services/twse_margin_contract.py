"""LISTED financing units: today's balance / previous session's next-day credit limits."""
from datetime import date
import math

def _security_rows(body, day):
    if body.get("stat")!="OK" or str(body.get("date"))!=day.replace("-",""):
        return None
    for table in body.get("tables",[]):
        fields=table.get("fields") or []
        if len(fields)>=8 and fields[0]=="代號" and fields[6]=="今日餘額" and fields[7]=="次一營業日限額":
            return table.get("data")
    return None

def parse_margin_summary(body,run_date,limits_body=None,previous_session=None):
    date.fromisoformat(run_date)
    missing={"date":run_date,"source":"twse.mi_margn.all.listed","balance":None,"limit":None,"coverage":0,
             "limit_publication_date":previous_session,"limit_effective_date":run_date,"unit":"1000_shares","status":"missing","ratio_lower":None,"ratio_upper":None}
    if not previous_session or previous_session>=run_date or limits_body is None:
        return missing
    current=_security_rows(body,run_date);prior=_security_rows(limits_body,previous_session)
    if not current or not prior:
        return missing
    try:
        limits={str(row[0]):float(str(row[7]).replace(",","")) for row in prior}
        balances={str(row[0]):float(str(row[6]).replace(",","")) for row in current}
    except (ValueError,TypeError,IndexError):
        return missing
    if len(balances)!=len(current) or len(limits)!=len(prior):
        return missing
    values=list(balances.values())+[limits[symbol] for symbol in balances if symbol in limits]
    if any(not math.isfinite(value) or value<0 for value in values):
        return missing
    balance=sum(balances.values());limit=sum(limits[symbol] for symbol in balances if symbol in limits)
    if limit<=0:
        return missing
    # Existing debt can exceed a newly reduced limit; it is a risk signal, not a parsing failure.
    unknown=[symbol for symbol in balances if symbol not in limits]
    ratio=balance/limit*100
    # D_total >= D_known. Unknown new-listing limits are never fabricated; this yields a rigorous upper bound.
    return {**missing,"balance":balance,"limit":None if unknown else limit,"known_limit":limit,
            "coverage":len(balances)-len(unknown),"universe":len(balances),"unknown_limit_symbols":unknown,
            "status":"bounded" if unknown else "complete","ratio_lower":0 if unknown else ratio,"ratio_upper":ratio}
