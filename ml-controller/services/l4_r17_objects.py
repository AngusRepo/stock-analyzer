"""R17 immutable storage with server-created receipt timing."""
from services.native_paper_source_capture import ImmutableNativeObjects
from services.l4_r17_state_storage import ReferencedStates


class _Backend(ImmutableNativeObjects):
    PREFIX = 'shadow/r17/v1/objects/'
    DELIVERY_PREFIX = 'shadow/r17/v1/deliveries/'


class _Adapter:
    PREFIX=_Backend.PREFIX
    DELIVERY_PREFIX=_Backend.DELIVERY_PREFIX
    def __init__(self,bucket):self.bucket=bucket;self._backend=_Backend(bucket)
    def put(self,payload):return self._backend.put(payload)
    def get(self,reference):return self._backend.get(reference)
    def __getattr__(self,name):return getattr(self._backend,name)


class R17Objects(ReferencedStates,_Adapter):
    def receipt_clock(self, reference, delivery_id):
        # Both payload and its discoverable alias must exist before the cutoff.
        self.get_header(reference)
        if self.lookup_delivery(delivery_id) != reference:
            raise ValueError('r17_receipt_alias_mismatch')
        rows=[]
        for name in (reference, self.DELIVERY_PREFIX + delivery_id + '.json'):
            blob=self.bucket.blob(name)
            blob.reload()
            if blob.time_created is None or not blob.generation:
                raise ValueError('r17_server_receipt_clock_missing')
            rows.append({'path':name,'generation':str(blob.generation),
                         'created_at':blob.time_created.isoformat()})
        return {'available_at':max(row['created_at'] for row in rows),
                'objects':rows,'authority':'object_store_server'}
