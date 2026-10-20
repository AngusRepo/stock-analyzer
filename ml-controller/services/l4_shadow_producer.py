"""Verified daily native inputs -> persistent private accounts, before open.

The source owner supplies each entry's own full-chain inference. Neither this
producer nor the execution job substitutes the active chain for an old entry.
"""
from copy import deepcopy
import hashlib
import json
from services.l4_challenger_comparison import verify,seal,instant,digest
from services.l4_challenger_rules import verify_document
from services.l4_shadow_daily import validate

DAILY_PREFIX='l4_distribution/shadow_inputs/v1/'


def read_reference(bucket,reference):
    if (not isinstance(reference,dict) or not reference.get('path')
            or not str(reference.get('generation','')).isdigit()
            or len(reference.get('sha256',''))!=64):
        raise ValueError('shadow_source_reference_invalid')
    blob=bucket.blob(reference['path']);blob.reload()
    if str(blob.generation)!=str(reference['generation']):
        raise ValueError('shadow_source_generation_changed')
    raw=blob.download_as_bytes(if_generation_match=blob.generation)
    if hashlib.sha256(raw).hexdigest()!=reference['sha256']:
        raise ValueError('shadow_source_bytes_changed')
    return json.loads(raw)


def initialize(accounts,bootstrap):
    """Explicit release-time bootstrap. Normal daily/tick jobs cannot do this."""
    verify(bootstrap)
    if (bootstrap.get('schema')!='l4-shadow-bootstrap-v1'
            or bootstrap.get('rules_document_sha256')!=verify_document()
            or bootstrap.get('production_effect') is not False):
        raise ValueError('shadow_bootstrap_contract_invalid')
    entries=bootstrap['entries'];champion=bootstrap['champion_id'];openings=bootstrap['openings']
    if not entries or champion not in entries or set(openings)!=set(entries):
        raise ValueError('shadow_bootstrap_inventory_invalid')
    # Validate every entry and opening before writing any registry revision.
    for key,entry in entries.items():
        if key!=entry['entry_id'] or entry['calibration']=='empirical_bayes':
            raise ValueError('shadow_bootstrap_entry_invalid')
        accounts.registry._validate_entry(entry,incumbent=key==champion)
        opening=openings[key];verify(opening['receipt'])
        if (opening.get('account_id')!=1
                or hashlib.sha256(opening['state_sql'].encode()).hexdigest()!=opening['state_checksum']
                or opening['receipt'].get('state_checksum')!=opening['state_checksum']
                or opening['receipt'].get('scope')!='paper_shadow'):
            raise ValueError('shadow_bootstrap_opening_invalid')
    current=accounts.registry.initialize(entries[champion])
    for key,entry in entries.items():
        if key!=champion:
            current=accounts.registry.register(entry,expected_registry_checksum=current['checksum'])
    states={}
    for key,opening in openings.items():
        states[key]=accounts.initialize(key,state_sql=opening['state_sql'],state_checksum=opening['state_checksum'],
            account_id=opening['account_id'],opening_receipt=opening['receipt'])['checksum']
    return dict(status='initialized',registry_checksum=current['checksum'],accounts=states,
                rules_document_sha256=verify_document(),production_effect=False,outer_acceptance_credit=0)


def build_daily_packet(source,entry,*,session_date,now):
    verify(source)
    if (source.get('schema')!='l4-shadow-native-day-source-v1'
            or source.get('rules_document_sha256')!=verify_document()
            or source.get('entry_checksum')!=entry['checksum']
            or source.get('serving_identity')!=entry['serving_identity']
            or source.get('session_date')!=session_date):
        raise ValueError('shadow_native_day_source_binding_invalid')
    required=('signal_date','session_date','next_open','source_receipt_shas','recommendations',
              'l4_allocation_inputs','trading_config','risk_config','seed_rows','execution_context')
    packet={key:deepcopy(source[key]) for key in required}
    packet['serving_identity']=deepcopy(entry['serving_identity'])
    for key in ('stock_rows','frozen_kv'):
        if key in source:packet[key]=deepcopy(source[key])
    packet=seal(packet)
    validate(packet,entry)
    if instant(source['observed_at'])>now or now>=instant(packet['next_open']):
        raise ValueError('shadow_daily_input_not_preopen')
    return packet


def produce_day(accounts,source_index,*,session_date,now):
    """All sources/entries are verified before the first private state mutation."""
    verify(source_index)
    registry,_=accounts.registry.current()
    if (not registry or source_index.get('schema')!='l4-shadow-native-day-index-v1'
            or source_index.get('rules_document_sha256')!=verify_document()
            or source_index.get('registry_checksum')!=registry['checksum']
            or source_index.get('session_date')!=session_date
            or set(source_index.get('sources',{}))!=set(registry['entries'])):
        raise ValueError('shadow_daily_source_inventory_invalid')
    prepared={}
    for key,entry in registry['entries'].items():
        source=read_reference(accounts.bucket,source_index['sources'][key])
        packet=build_daily_packet(source,entry,session_date=session_date,now=now)
        head,_=accounts.current(key)
        if not head:raise ValueError('shadow_daily_account_not_initialized')
        prepared[key]=(packet,head)
    results={}
    for key,(packet,head) in prepared.items():
        daily=head.get('daily_inputs') or {}
        if daily.get('session_date')==session_date:
            if daily.get('packet_checksum')!=packet['checksum']:
                raise ValueError('shadow_daily_frozen_packet_changed')
            _,account=accounts._entry(key)
            action,_=accounts._read(account+'/actions/'+digest('prepare:'+session_date)+'.json')
            if not action or action.get('input_receipt_checksum')!=daily['receipt_checksum']:
                raise ValueError('shadow_daily_preparation_receipt_missing')
        else:
            action=accounts.prepare_day(key,expected_state_checksum=head['checksum'],packet=packet)
        results[key]=dict(packet_checksum=packet['checksum'],receipt_checksum=action['checksum'])
    return dict(status='prepared',session_date=session_date,accounts=results,
                rules_document_sha256=verify_document(),production_effect=False,outer_acceptance_credit=0)
