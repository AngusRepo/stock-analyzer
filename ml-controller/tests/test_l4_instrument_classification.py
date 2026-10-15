import pytest
from services.l4_instrument_classification import parse,select,capture
from test_l4_forward_refresh import Bucket

def html(prefix='1'):
    rows=['<tr><td>股票</td></tr>']
    for i in range(100):
        rows.append(f'<tr><td>{prefix}{i:03d}　Example</td><td>TW0001101004</td><td>2020/01/01</td><td>市場</td><td>工業</td><td>ESVUFR</td><td></td></tr>')
    return ('<table>'+''.join(rows)+'</table>').encode('cp950')

def test_official_full_listing_is_parsed_without_historical_subset():
    rows=parse(html(),2,'2026-10-15T10:00:00+00:00')
    assert len(rows)==100 and rows[0]['official_market']=='TWSE'
    roster=[{'symbol':'1000'},{'symbol':'1001'},{'symbol':'9999'}]
    rows[1]['listing_date']='2026-10-16'
    selected,classification,excluded=select(roster,{'rows':rows},'2026-10-15')
    assert selected==[roster[0]] and len(classification['accepted_evidence'])==100
    assert [r['symbol'] for r in excluded]==['1001','9999']

def test_empty_or_truncated_official_page_fails():
    with pytest.raises(ValueError,match='listing_incomplete'):parse(b'<html>maintenance</html>',2,'now')

def test_retry_uses_first_immutable_complete_official_listing():
    from types import SimpleNamespace
    bucket=Bucket();calls=[]
    def fetch(url):
        calls.append(url)
        return SimpleNamespace(content=html('1' if url.endswith('=2') else '2'),raise_for_status=lambda:None)
    first=capture(bucket,'2026-10-15',fetch=fetch)
    again=capture(bucket,'2026-10-15',fetch=lambda url:pytest.fail('already frozen'))
    assert first==again and len(calls)==2
