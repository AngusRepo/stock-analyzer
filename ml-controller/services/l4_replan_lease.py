"""Cross-instance L4 claim; independent of the caller's HTTP/Worker lifetime."""
from contextlib import contextmanager
import logging
from threading import Event, Thread
from uuid import uuid4

log = logging.getLogger(__name__)
GROUP = 'l4-replan-compute:1'


@contextmanager
def replan_claim(db):
    owner = str(uuid4())
    claimed = db.query("""INSERT INTO maintenance_task_leases
        (lease_group,task_name,owner_id,lease_expires_at,acquired_at,heartbeat_at)
        VALUES (?,'l4-replan-compute',?,datetime('now','+600 seconds'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT(lease_group) DO UPDATE SET owner_id=excluded.owner_id,
          lease_expires_at=excluded.lease_expires_at,acquired_at=CURRENT_TIMESTAMP,heartbeat_at=CURRENT_TIMESTAMP
        WHERE maintenance_task_leases.lease_expires_at < CURRENT_TIMESTAMP
          OR maintenance_task_leases.owner_id=excluded.owner_id
        RETURNING owner_id""", [GROUP, owner])
    if not claimed or claimed[0]['owner_id'] != owner:
        yield None
        return
    stop = Event()
    lost = Event()

    def renew():
        rows = db.query("""UPDATE maintenance_task_leases
            SET lease_expires_at=datetime('now','+600 seconds'),heartbeat_at=CURRENT_TIMESTAMP
            WHERE lease_group=? AND owner_id=? AND lease_expires_at>=CURRENT_TIMESTAMP
            RETURNING owner_id""", [GROUP, owner])
        if not rows:
            raise RuntimeError('l4_replan_lease_lost')

    def heartbeat():
        while not stop.wait(60):
            try:
                renew()
            except Exception:
                lost.set()
                return

    def fence():
        if lost.is_set():
            raise RuntimeError('l4_replan_lease_lost')
        renew()

    thread = Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        yield fence
    finally:
        stop.set()
        thread.join(timeout=65)
        try:
            db.query('DELETE FROM maintenance_task_leases WHERE lease_group=? AND owner_id=? RETURNING owner_id', [GROUP, owner])
        except Exception:
            log.warning('L4 claim release failed; bounded lease expiry will recover it')
