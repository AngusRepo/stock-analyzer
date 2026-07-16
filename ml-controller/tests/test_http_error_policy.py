from services.http_error_policy import public_http_error


def test_server_errors_never_expose_exception_details() -> None:
    assert public_http_error(502, "connection failed: secret-token@internal") == (
        "upstream_or_internal_error",
        "The request could not be completed",
    )


def test_client_errors_only_expose_stable_machine_codes() -> None:
    assert public_http_error(401, "invalid_controller_token") == (
        "invalid_controller_token",
        "invalid_controller_token",
    )
    assert public_http_error(400, "bad path C:/secret/config.json") == (
        "request_rejected",
        "The request was rejected",
    )
