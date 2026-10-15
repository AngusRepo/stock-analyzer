"""Freeze the complete official TWSE/TPEx listing before daily native inference."""
from datetime import datetime,timezone,date
from html.parser import HTMLParser
import hashlib,json,time
from services.l4_forward_refresh import publish
from services.l4_native_observation import read_reference

class TableRows(HTMLParser):
    def __init__(self):
        super().__init__();self.rows=[];self.row=[];self.cell=None
    def handle_starttag(self,tag,attrs):
        if tag=='tr':self.row=[]
        if tag=='td':self.cell=[]
    def handle_data(self,value):
        if self.cell is not None:self.cell.append(value)
    def handle_endtag(self,tag):
        if tag=='td' and self.cell is not None:self.row.append(' '.join(self.cell).strip());self.cell=None
        if tag=='tr' and self.row:self.rows.append(self.row)

def parse(raw,mode,observed_at):
    parser=TableRows();parser.feed(raw.decode('cp950',errors='replace'))
    section='';rows=[]
    for cells in parser.rows:
        if len(cells)==1:section=cells[0]
        if len(cells)<7 or len(cells[1])!=12:continue
        cfi=cells[5];stock=cfi.startswith(('ES','ED'));etf='ETF' in section
        if not stock and not etf:continue
        symbol=cells[0].replace('\u3000',' ').split()[0];listed=cells[2].replace('/','-')
        date.fromisoformat(listed)
        rows.append(dict(symbol=symbol,cfi=cfi,isin=cells[1],listing_date=listed,
            instrument_type='stock' if stock else 'etf',official_market='TWSE' if mode==2 else 'OTC',
            source_sha256=hashlib.sha256(raw).hexdigest(),observed_at=observed_at))
    if len(rows)<100 or len({r['symbol'] for r in rows})!=len(rows):
        raise ValueError('l4_native_official_listing_incomplete')
    return rows

def select(roster,catalog,day):
    records={r['symbol']:r for r in catalog['rows']}
    if len(records)!=len(catalog['rows']):raise ValueError('l4_native_official_listing_duplicate')
    selected=[];excluded=[]
    for r in roster:
        record=records.get(r['symbol'])
        if record is None or record['listing_date']>day:
            excluded.append(dict(symbol=r['symbol'],reason='outside_observed_official_listing',
                official_listing_date=None if record is None else record['listing_date']))
        else:selected.append(r)
    # This is a prospective observed listing boundary, never retroactively applied
    # to the historical training universe. Every omitted source row is retained.
    accepted={s:r for s,r in records.items() if r['cfi'].startswith(('ES','ED'))}
    classification=dict(accepted_evidence=accepted,excluded_symbols=[r for r in records.values() if r['instrument_type']=='etf'])
    return selected,classification,excluded

def capture(bucket,day,*,fetch=None):
    path='l4_distribution/native_listing_index/'+day+'.json';index=bucket.blob(path)
    if index.exists():
        ref=json.loads(index.download_as_bytes());return read_reference(bucket,ref),ref
    import httpx
    from google.api_core.exceptions import PreconditionFailed
    fetch=fetch or (lambda url:httpx.get(url,timeout=60,follow_redirects=True))
    rows=[];sources=[];observed=datetime.now(timezone.utc).isoformat()
    for mode in (2,4):
        url=f'https://isin.twse.com.tw/isin/C_public.jsp?strMode={mode}'
        for attempt in range(3):
            try:
                response=fetch(url);response.raise_for_status();raw=response.content
                parsed=parse(raw,mode,observed);break
            except (httpx.HTTPError,ValueError):
                if attempt==2:raise
                time.sleep(2**attempt)
        # Keep raw official bytes in a content-addressed JSON envelope.
        import base64
        source=publish(bucket,'native_listing_sources',dict(url=url,observed_at=observed,
            raw_base64=base64.b64encode(raw).decode(),raw_sha256=hashlib.sha256(raw).hexdigest()))
        rows.extend(parsed);sources.append(source)
    body=dict(schema_version='l4-official-observed-listing-v1',business_date=day,observed_at=observed,
        rows=rows,sources=sources,policy='prospective_official_twse_tpex_listing_not_historical_filter')
    if len({r['symbol'] for r in rows})!=len(rows):raise ValueError('l4_native_official_listing_duplicate')
    ref=publish(bucket,'native_listings',body)
    try:index.upload_from_string(json.dumps(ref),if_generation_match=0)
    except PreconditionFailed:
        ref=json.loads(index.download_as_bytes());body=read_reference(bucket,ref)
    return body,ref
