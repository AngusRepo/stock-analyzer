from routers.sector_flow import _parse_twse_price_body


def test_parse_twse_price_csv_with_roc_report_date_and_quoted_numbers():
    csv_text = "\r\n".join([
        "date,symbol,name,volume,amount,open,high,low,close,change,trades",
        '"1150624","2330","TSMC","55,082,816","81,256,153,200","1480.00","1490.00","1465.00","1475.00","+5.00","42,000"',
    ])

    report_date, prices = _parse_twse_price_body(csv_text)

    assert report_date == "2026-06-24"
    assert len(prices) == 1
    assert prices[0]["symbol"] == "2330"
    assert prices[0]["open"] == 1480
    assert prices[0]["high"] == 1490
    assert prices[0]["low"] == 1465
    assert prices[0]["close"] == 1475
    assert prices[0]["volume"] == 55082816
