"""Original debate with immutable per-round inference and private audit output."""
from __future__ import annotations

import asyncio

from services.debate_execution_scope import DebateExecutionPorts, private_debate_execution
from services.paired_nav_journal import encode
from services.llm_debate_client import DEBATE_MODEL_POLICY, validate_role_model, provider_error_code


class NativeWorkersAIRead:
    def __call__(self, request: dict) -> dict:
        from services.llm_debate_client import call_llm
        if (set(request) != {'model', 'role', 'system', 'user', 'temperature', 'max_tokens'}
                or request['model'] != validate_role_model(request['role'], request['model'])
                or not isinstance(request['system'], str) or not isinstance(request['user'], str)
                or type(request['temperature']) not in (int, float) or not 0 <= request['temperature'] <= 1
                or type(request['max_tokens']) is not int or not 1 <= request['max_tokens'] <= 512):
            raise ValueError('native_debate_inference_contract_invalid')
        usage = []
        async def cost(*values):
            usage.append(list(values))
        async def run():
            return await call_llm(request['system'], request['user'], temperature=request['temperature'],
                max_tokens=request['max_tokens'], ab_force=DEBATE_MODEL_POLICY, role=request['role'], model=request['model'], cost_sink=cost)
        try:
            text, source = asyncio.run(run())
        except RuntimeError as exc:
            # An actual recorded provider outage is not a missing source read.
            # The original debate responds retryable_error and never APPROVE.
            return {'error': provider_error_code(exc, 'native_workers_ai_unavailable'), 'usage': usage}
        return {'text': text, 'source': source, 'usage': usage}


class NativeCapturedDebate:
    def __init__(self, *, source_capture, max_rounds: int, session_date: str, model_name: str,
                 model_assignment: str | None = DEBATE_MODEL_POLICY):
        self.source_capture, self.max_rounds, self.session_date = source_capture, 2, session_date
        self.model_name, self.model_assignment = model_name, model_assignment

    @property
    def source_identity(self) -> dict:
        return {'owner': 'native-captured-debate-v3', 'max_rounds': self.max_rounds,
            'model_name': self.model_name, 'model_assignment': self.model_assignment,
            'session_date': self.session_date}

    def read_native(self, request: dict, frame: dict) -> dict:
        from routers.debate import BuyDebateBatchRequest
        from services.debate_service import run_buy_debate_batch
        batch = BuyDebateBatchRequest.model_validate_json(request['body'])
        if (self.model_name != DEBATE_MODEL_POLICY or not 1 <= batch.concurrent <= 50
                or len(batch.candidates) > 50
                or any(c.cache_key_date not in (None, self.session_date) for c in batch.candidates)):
            raise ValueError('native_debate_batch_contract_invalid')
        audits = []
        async def infer(system, user, *, temperature, max_tokens, role, model, **unused):
            item = {'model': validate_role_model(role, model), 'role': role, 'system': system, 'user': user,
                    'temperature': temperature, 'max_tokens': max_tokens}
            record = await asyncio.to_thread(self.source_capture.read, 'native_debate_llm', item, frame)
            response = record['response']
            if response.get('error'):
                raise RuntimeError(response['error'])
            return response['text'], response['source']
        async def audit(**values):
            audits.append(values)
        async def execute():
            with private_debate_execution(DebateExecutionPorts(self.max_rounds, infer, audit, self.model_assignment)):
                return await run_buy_debate_batch([{**c.model_dump(), 'cache_key_date': self.session_date} for c in batch.candidates], concurrent=batch.concurrent)
        results = asyncio.run(execute())
        return {'status': 200, 'headers': {'content-type': 'application/json'}, 'body': encode({
            'results': results, 'count': len(results), 'batch_size': len(batch.candidates),
            'private_audits': sorted(audits, key=lambda item: encode(item))})}
