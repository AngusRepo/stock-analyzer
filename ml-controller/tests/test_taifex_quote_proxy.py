from services.taifex_quote import parse_taifex_quote


def test_parse_taifex_night_quote_selects_m_contract_and_negative_change() -> None:
    body = {
        "RtData": {
            "QuoteList": [
                {
                    "SymbolID": "TXFI6-M",
                    "CLastPrice": "44520",
                    "CRefPrice": "44740",
                    "CDate": "20260824",
                    "CTime": "013000",
                },
                {
                    "SymbolID": "TXFI6-F",
                    "CLastPrice": "44900",
                    "CRefPrice": "44740",
                    "CDate": "20260824",
                    "CTime": "134500",
                },
            ]
        }
    }

    quote = parse_taifex_quote(body, "1")

    assert quote is not None
    assert quote["symbol"] == "TXFI6-M"
    assert quote["lastPrice"] == 44520
    assert quote["changePoints"] == -220


def test_parse_taifex_quote_rejects_invalid_reference() -> None:
    assert parse_taifex_quote({
        "RtData": {
            "QuoteList": [{
                "SymbolID": "TXFI6-M",
                "CLastPrice": "44520",
                "CRefPrice": "0",
            }]
        }
    }, "1") is None
