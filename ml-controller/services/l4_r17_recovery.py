"""Recover interrupted execution only from receipts actually captured on time."""
from services.paired_nav_journal import digest, _timestamp
from services.native_paper_time import frame_capture_deadline


class SealedSourceReplay:
    """No market/network capability. Missing reads invalidate the entire frame.

    Native code can catch a failed read and choose a safety fallback. Track that
    failure independently so such a fallback cannot turn an unobserved frame
    into a historical execution receipt.
    """
    def __init__(self, capture, objects):
        self.objects = objects
        self.readers = capture.inference_reads
        self.failures = []

    def read(self, operation, request, frame):
        reader = self.readers.get(operation)
        owner = getattr(reader, '__self__', reader)
        key = {'frame_id': frame['input_id'], 'observed_at': frame['observed_at'],
               'operation': operation, 'request': request,
               'source_context': getattr(owner, 'source_identity', None)}
        try:
            delivery = digest(key)
            ref = self.objects.lookup_delivery(delivery)
            if ref is None:
                raise ValueError('r17_recovery_original_read_missing')
            record = self.objects.get(ref)
            if record.get('identity') != key:
                raise ValueError('r17_recovery_source_identity')
            receipt = self.objects.receipt_clock(ref, delivery)
            due, deadline = _timestamp(frame['observed_at']), frame_capture_deadline(frame)
            if (receipt.get('authority') != 'object_store_server'
                    or not due <= _timestamp(record['captured_at']) < deadline
                    or not due <= _timestamp(receipt['available_at']) < deadline):
                raise ValueError('r17_recovery_source_not_captured_on_time')
            return record
        except Exception:
            self.failures.append(digest(key))
            raise

    def verify(self):
        if self.failures:
            raise ValueError('r17_recovery_original_read_missing')
