"""Explicit, pinned lifecycle evidence for financial request applicability."""
import hashlib,html,json,re
from pathlib import Path
import pandas as pd


def verify_financial_lifecycle(path, expected_sha256, source, *, start_date, end_date):
    path=Path(path).resolve();raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=expected_sha256:
        raise ValueError('financial_lifecycle_manifest_checksum')
    record=json.loads(raw)
    if (record.get('schema')!='financial-lifecycle-window-v1' or
        record.get('capture_receipt_sha256')!=source.binding['raw_receipt_sha256'] or
        record.get('start_date')!=start_date or record.get('end_date')!=end_date):
        raise ValueError('financial_lifecycle_scope_mismatch')
    start,end=pd.Timestamp(start_date),pd.Timestamp(end_date)
    if pd.isna(start) or pd.isna(end) or start>end or start.tz or end.tz or start!=start.normalize() or end!=end.normalize():
        raise ValueError('financial_lifecycle_window_invalid')
    symbols=record.get('symbols',[])
    if not symbols or len(set(symbols))!=len(symbols) or set(symbols)-set(source.roster):
        raise ValueError('financial_lifecycle_symbols_invalid')
    evidence=record['evidence'];expected={'terminated','twse','tpex','emerging'}
    if set(evidence)!=expected:raise ValueError('financial_lifecycle_evidence_incomplete')
    documents={};bindings={}
    for name,item in evidence.items():
        relative=Path(item['path']);p=(path.parent/relative).resolve()
        if relative.is_absolute() or not p.is_relative_to(path.parent):
            raise ValueError('financial_lifecycle_evidence_path')
        data=p.read_bytes()
        if hashlib.sha256(data).hexdigest()!=item['sha256']:
            raise ValueError('financial_lifecycle_evidence_checksum')
        documents[name]=data;bindings[name]={'path':item['path'],'sha256':item['sha256']}
    active=set()
    for name in ['twse','tpex','emerging']:
        rows=json.loads(documents[name])
        if not isinstance(rows,list) or not rows:raise ValueError('financial_lifecycle_current_master_invalid')
        for row in rows:
            symbol=row.get('公司代號') or row.get('SecuritiesCompanyCode')
            if symbol is None:raise ValueError('financial_lifecycle_current_master_identity')
            active.add(str(symbol))
    matches={s:[] for s in symbols}
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>',documents['terminated'].decode('utf8'),re.S):
        cells=[html.unescape(re.sub('<[^>]+>','',c)).strip() for c in re.findall(r'<td[^>]*>(.*?)</td>',tr,re.S)]
        if len(cells)==3 and cells[2] in matches:matches[cells[2]].append(cells)
    prices=source.get('price:收盤價')
    if prices.index.max()<end or prices.index.min()>start:
        raise ValueError('financial_lifecycle_price_window_uncovered')
    result=[]
    for symbol in symbols:
        if symbol in active or len(matches[symbol])!=1:
            raise ValueError('financial_lifecycle_active_or_ambiguous_owner')
        cells=matches[symbol][0];m=re.fullmatch(r'(\d{2,3})年(\d{2})月(\d{2})日',cells[0])
        if not m:raise ValueError('financial_lifecycle_termination_date_invalid')
        year,month,day=map(int,m.groups());terminated=pd.Timestamp(year+1911,month,day)
        if terminated>=start or symbol not in prices.columns:
            raise ValueError('financial_lifecycle_termination_not_before_window')
        quotes=prices[symbol].dropna()
        if quotes.empty or (quotes.index>=terminated).any():
            raise ValueError('financial_lifecycle_missing_history_or_later_quote')
        result.append({'symbol':symbol,'termination_date':str(terminated.date()),'official_row':cells,
            'last_observed_quote':str(quotes.index.max().date()),'request_price_rows':0,
            'classification':'terminated_before_request_window','roster_retained':True})
    return {'status':'verified_terminated_financial_applicability_for_exact_window',
        'manifest_sha256':expected_sha256,'capture_receipt_sha256':source.binding['raw_receipt_sha256'],
        'start_date':start_date,'end_date':end_date,'evidence':bindings,'symbols':result,
        'policy':'retain_roster_and_raw; output_null_for_no_eligible_issuer_sessions',
        'certifies_full_pool_or_financial_vintage':False}
