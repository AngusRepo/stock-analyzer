import asyncio
from routers import finlab, pipeline


def test_callback_never_probes_or_spawns_before_durable_worker_ack(monkeypatch):
    calls=[]
    async def forward(body): calls.append(body['run_id'])
    async def prohibited(body): raise AssertionError('slow preparation must not block callback')
    monkeypatch.setattr(pipeline,'_callback_worker',forward)
    monkeypatch.setattr(finlab,'_maybe_spawn_long_sequence_refresh',prohibited)
    result=asyncio.run(finlab.finlab_backfill_controller_callback(finlab.FinLabBackfillCallbackRequest(status='success',run_id='run')))
    assert calls==['run'] and result['forwarded'] is True
    assert result['long_sequence_refresh']['status']=='queued_by_worker_outbox'


def test_sequence_probe_does_not_block_controller_event_loop(monkeypatch):
    import time
    progress=[]
    def blocking(uri): time.sleep(.06); return False
    monkeypatch.setenv('GCS_BUCKET_NAME','fixture')
    monkeypatch.setenv('FINLAB_LONG_SEQUENCE_REFRESH_ENABLED','1')
    monkeypatch.setenv('FINLAB_LONG_SEQUENCE_LANES','daily_price')
    monkeypatch.setattr(finlab,'_gcs_object_exists',blocking)
    async def run():
        task=asyncio.create_task(finlab.finlab_sequence_refresh(finlab.FinLabBackfillCallbackRequest(status='success',run_id='finlab-v4-daily-20261001-fixture')))
        await asyncio.sleep(.01);progress.append(not task.done())
        return await task
    result=asyncio.run(run())
    assert result['reason']=='tail_daily_price_adjusted_ohlc_label_contract_missing'
    assert progress==[True]
