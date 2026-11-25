import asyncio
import json
import logging
from types import SimpleNamespace

from services import json_logging
from services.cloud_run_jobs_client import CloudRunJobsClient
from services.json_logging import (
    ROOT_TICKET_ENV,
    JsonLogFormatter,
    RootTicketMiddleware,
    current_root_ticket_id,
    reset_root_ticket_id,
    set_root_ticket_id,
)


def _record(message='hello %s', args=('world',), exc_info=None):
    return logging.LogRecord('pipeline_job', logging.WARNING, __file__, 1, message, args, exc_info)


def test_formatter_is_one_json_line_with_the_same_message_text(monkeypatch):
    monkeypatch.delenv(ROOT_TICKET_ENV, raising=False)
    line = JsonLogFormatter().format(_record())
    assert '\n' not in line
    payload = json.loads(line)
    assert payload['message'] == 'hello world'
    assert payload['severity'] == 'WARNING' and payload['logger'] == 'pipeline_job'
    assert payload['time'].endswith('Z') and 'root_ticket_id' not in payload
    try:
        raise ValueError('boom')
    except ValueError:
        import sys
        payload = json.loads(JsonLogFormatter().format(_record('failed', (), sys.exc_info())))
    assert payload['message'].startswith('failed\nTraceback') and 'ValueError: boom' in payload['message']


def test_root_ticket_from_context_then_job_env(monkeypatch):
    monkeypatch.setenv(ROOT_TICKET_ENV, 'scheduler-ticket-v1-env')
    assert current_root_ticket_id() == 'scheduler-ticket-v1-env'
    token = set_root_ticket_id('scheduler-ticket-v1-req')
    try:
        assert json.loads(JsonLogFormatter().format(_record()))['root_ticket_id'] == 'scheduler-ticket-v1-req'
    finally:
        reset_root_ticket_id(token)
    monkeypatch.setenv(ROOT_TICKET_ENV, 'bad value with spaces')
    assert current_root_ticket_id() is None


def test_configure_keeps_existing_handlers_and_levels(monkeypatch):
    root = logging.getLogger()
    sentinel = logging.NullHandler()
    monkeypatch.setattr(root, 'handlers', [sentinel])
    level = root.level
    json_logging.configure_json_logging(logging.INFO)
    assert root.handlers == [sentinel] and root.level == level
    access = logging.getLogger('uvicorn.access')
    handler = logging.StreamHandler()
    monkeypatch.setattr(access, 'handlers', [handler])
    json_logging.configure_json_logging()
    assert isinstance(handler.formatter, JsonLogFormatter)


def test_middleware_binds_header_for_the_request_only(monkeypatch):
    monkeypatch.delenv(ROOT_TICKET_ENV, raising=False)
    seen = []

    async def app(scope, receive, send):
        seen.append(current_root_ticket_id())

    middleware = RootTicketMiddleware(app)
    scope = {'type': 'http', 'headers': [(b'x-root-ticket-id', b'scheduler-ticket-v1-abc')]}
    asyncio.run(middleware(scope, None, None))
    asyncio.run(middleware({'type': 'http', 'headers': [(b'x-root-ticket-id', b'"><script>')]}, None, None))
    assert seen == ['scheduler-ticket-v1-abc', None]
    assert current_root_ticket_id() is None


def _client(monkeypatch):
    client = object.__new__(CloudRunJobsClient)
    client._parent = 'projects/test/locations/region/jobs/pipeline-v2'
    client._require_source_alignment = False
    sent = []

    def run(**kwargs):
        sent.append(kwargs['request'])
        return SimpleNamespace(metadata=SimpleNamespace(name=client._parent + '/executions/one'))
    monkeypatch.setattr(client, 'get_active_execution', lambda **_: None)
    monkeypatch.setattr(client, '_get_client', lambda: SimpleNamespace(run_job=run))
    return client, sent


def _env(request):
    overrides = request.overrides
    if not overrides or not overrides.container_overrides:
        return {}
    return {item.name: item.value for item in overrides.container_overrides[0].env}


def test_every_job_execution_carries_the_root_ticket(monkeypatch):
    monkeypatch.delenv(ROOT_TICKET_ENV, raising=False)
    client, sent = _client(monkeypatch)
    caller_env = {'PIPELINE_RUN_DATE': '2026-11-24'}
    client.run_job(env_overrides=caller_env)
    assert _env(sent[-1]) == caller_env, 'no ticket in scope: request unchanged'
    token = set_root_ticket_id('scheduler-ticket-v1-root')
    try:
        client.run_job(env_overrides=caller_env)
        assert _env(sent[-1]) == {**caller_env, ROOT_TICKET_ENV: 'scheduler-ticket-v1-root'}
        assert caller_env == {'PIPELINE_RUN_DATE': '2026-11-24'}, "caller's mapping is not mutated"
        client.run_job()
        assert _env(sent[-1]) == {ROOT_TICKET_ENV: 'scheduler-ticket-v1-root'}
        client.run_job(env_overrides={ROOT_TICKET_ENV: 'explicit'})
        assert _env(sent[-1]) == {ROOT_TICKET_ENV: 'explicit'}
    finally:
        reset_root_ticket_id(token)
    # A Job that launches another Job forwards its own env value.
    monkeypatch.setenv(ROOT_TICKET_ENV, 'scheduler-ticket-v1-job')
    client.run_job()
    assert _env(sent[-1]) == {ROOT_TICKET_ENV: 'scheduler-ticket-v1-job'}
