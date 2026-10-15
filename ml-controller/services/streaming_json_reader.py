"""Bounded JSON decoding with shared keys and the original numeric semantics."""
from decimal import Decimal
import logging
import ijson
from ijson.common import JSONError


def load(source, *, prefixes=None):
    start=source.tell()
    if source.read(3)==b'\xef\xbb\xbf':
        start=source.tell()
    source.seek(start)
    try:
        return _parse(source,prefixes=prefixes,use_float=True)
    except JSONError as exc:
        if not any(word in str(exc).lower() for word in ('overflow','underflow')):
            raise
        logging.getLogger(__name__).info('[StreamingJson] native_numeric_fallback')
    # Leave the exception handler before replay: its traceback can otherwise
    # retain a nearly complete decoded document alongside the second attempt.
    source.seek(start)
    return _parse(source,prefixes=prefixes,use_float=False)


def _parse(source, *, prefixes, use_float):
    keys={}
    builder=ijson.ObjectBuilder()
    selected,depth=None,0
    result={}
    def assign(prefix,value):
        parent=result
        parts=prefix.split('.')
        for part in parts[:-1]:parent=parent.setdefault(part,{})
        parent[parts[-1]]=value
    events=(ijson.parse(source,use_float=use_float) if prefixes is not None else
            (('',event,value) for event,value in ijson.basic_parse(source,use_float=use_float)))
    for prefix,event,value in events:
        if prefixes is not None and selected is None:
            if prefix not in prefixes or event in ('map_key','end_map','end_array'):
                continue
            selected,builder,depth=prefix,ijson.ObjectBuilder(),0
        if event=='map_key':value=keys.setdefault(value,value)
        elif isinstance(value,Decimal):value=float(value)
        builder.event(event,value)
        if prefixes is not None:
            depth+=int(event in ('start_map','start_array'))-int(event in ('end_map','end_array'))
            if depth==0:
                assign(selected,builder.value)
                selected=None
    return result if prefixes is not None else builder.value
