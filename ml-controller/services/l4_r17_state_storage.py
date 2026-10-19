"""Content-addressed state references; keep minute receipts small and verifiable."""
import hashlib
import zlib
import threading
from collections import OrderedDict

# Storage cache only; no financial threshold or retention policy. Old records
# remain in immutable storage. Compressed content is bounded across warm ticks.
_CACHE=OrderedDict()
_CACHE_BYTES=0
_CACHE_LIMIT=64*1024*1024
_LOCK=threading.Lock()


def chunks(sql):
    """Content boundaries remain stable when earlier account rows change."""
    start=position=0
    while position<len(sql):
        end=sql.find('\n',position)
        end=len(sql) if end<0 else end+1
        boundary=hashlib.sha256(sql[position:end].encode()).digest()[0]==0
        position=end
        if boundary:
            yield sql[start:end];start=end
    if start<len(sql):yield sql[start:]


def _cache_get(key):
    with _LOCK:
        value=_CACHE.get(key)
        if value is not None:_CACHE.move_to_end(key)
    if value is None:return None
    raw=zlib.decompress(value[0]).decode()
    if hashlib.sha256(raw.encode()).hexdigest()!=value[1]:raise ValueError('r17_chunk_cache_corrupt')
    return {'state_sql':raw,'state_checksum':value[1]}


def _cache_put(key,value):
    global _CACHE_BYTES
    packed=zlib.compress(value['state_sql'].encode(),level=1)
    if len(packed)>_CACHE_LIMIT:return
    with _LOCK:
        previous=_CACHE.pop(key,None)
        if previous:_CACHE_BYTES-=len(previous[0])
        _CACHE[key]=(packed,value['state_checksum']);_CACHE_BYTES+=len(packed)
        while _CACHE_BYTES>_CACHE_LIMIT:
            _,evicted=_CACHE.popitem(last=False);_CACHE_BYTES-=len(evicted[0])


class ReferencedStates:
    def _cache_key(self,reference):
        bucket=getattr(self,'bucket',None)
        return (getattr(bucket,'name',id(bucket) if bucket is not None else id(self)),reference)

    def _write_chunk(self,raw):
        from services.paired_nav_journal import digest
        payload={'state_sql':raw,'state_checksum':hashlib.sha256(raw.encode()).hexdigest()}
        prefix=getattr(self,'PREFIX',None)
        predicted=prefix+digest(payload)+'.json' if prefix else None
        if predicted and _cache_get(self._cache_key(predicted))==payload:return predicted
        reference=super().put(payload)
        _cache_put(self._cache_key(reference),payload)
        return reference

    def _read_chunk(self,reference):
        key=self._cache_key(reference);value=_cache_get(key)
        if value is None:
            value=super().get(reference)
            if (set(value)!={'state_sql','state_checksum'} or
                    hashlib.sha256(value['state_sql'].encode()).hexdigest()!=value['state_checksum']):
                raise ValueError('r17_chunk_checksum_invalid')
            _cache_put(key,value)
        return value['state_sql']

    def _state_reference(self,state):
        if set(state)!={'state_sql','state_checksum'}:
            raise ValueError('r17_state_shape_invalid')
        checksum=hashlib.sha256(state['state_sql'].encode()).hexdigest()
        if checksum!=state['state_checksum']:raise ValueError('r17_state_checksum_invalid')
        known=getattr(self,'_r17_state_references',None)
        if known is None:self._r17_state_references={};known=self._r17_state_references
        if checksum not in known:
            if len(state['state_sql'])<64*1024:known[checksum]=super().put(state)
            else:
                manifest={'schema':'r17-sql-chunks-v1','state_checksum':checksum,
                    'characters':len(state['state_sql']),
                    'chunks':[self._write_chunk(raw) for raw in chunks(state['state_sql'])]}
                known[checksum]=super().put(manifest)
        return {'r17_state_ref':known[checksum]}

    def _compact(self,payload):
        compact=dict(payload)
        if isinstance(payload.get('states'),dict):
            compact['states']={arm:self._state_reference(state) for arm,state in payload['states'].items()}
        if isinstance(payload.get('state'),dict) and 'state_sql' in payload['state']:
            compact['state']=self._state_reference(payload['state'])
        if 'state_sql' in payload and set(payload)!={'state_sql','state_checksum'}:
            compact={k:v for k,v in compact.items() if k not in ('state_sql','state_checksum')}
            compact['r17_checkpoint_state']=self._state_reference({k:payload[k] for k in ('state_sql','state_checksum')})
        return compact

    def put(self,payload):return super().put(self._compact(payload))

    def verify_payload(self,reference,payload):
        return self.get_header(reference)==self._compact(payload)

    def get_header(self,reference):
        # The base verifies the stored object's checksum before exposing refs.
        result=super().get(reference)
        if isinstance(result.get('identity'),dict) and hasattr(self,'_verified_delivery_ids'):
            from services.paired_nav_journal import digest
            self._verified_delivery_ids[reference]=digest(result['identity'])
        return result

    def resolve_state(self,state):
        if set(state)=={'r17_state_ref'}:
            result=super().get(state['r17_state_ref'])
            if result.get('schema')=='r17-sql-chunks-v1':
                with _LOCK:warm=all(self._cache_key(ref) in _CACHE for ref in result['chunks'])
                if warm:raw=''.join(self._read_chunk(ref) for ref in result['chunks'])
                else:
                    from concurrent.futures import ThreadPoolExecutor
                    with ThreadPoolExecutor(max_workers=8) as pool:
                        raw=''.join(pool.map(self._read_chunk,result['chunks']))
                if len(raw)!=result['characters']:raise ValueError('r17_state_chunk_length')
                result={'state_sql':raw,'state_checksum':result['state_checksum']}
            if set(result)!={'state_sql','state_checksum'}:raise ValueError('r17_state_reference_shape')
            if hashlib.sha256(result['state_sql'].encode()).hexdigest()!=result['state_checksum']:
                raise ValueError('r17_state_checksum_invalid')
            return result
        return state # Existing immutable unreferenced receipts remain readable.

    def get(self,reference):
        result=self.get_header(reference)
        if isinstance(result.get('states'),dict):
            result={**result,'states':{a:self.resolve_state(s) for a,s in result['states'].items()}}
        if isinstance(result.get('state'),dict):result={**result,'state':self.resolve_state(result['state'])}
        if 'r17_checkpoint_state' in result:
            state=self.resolve_state(result['r17_checkpoint_state'])
            result={**{k:v for k,v in result.items() if k!='r17_checkpoint_state'},**state}
        return result
