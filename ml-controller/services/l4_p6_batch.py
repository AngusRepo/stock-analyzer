"""Create immutable P6 phase packages locally; no upload, fit or publication."""
import hashlib
import io
import json
from pathlib import Path
import zipfile
from services import l4_p6_recipe as recipe
from services.l4_p6_final_inputs import _read_fold
from services.l4_distribution import digest
from services.training_dual_cutoff import TrainingCutoff


def _sha(raw):return hashlib.sha256(raw).hexdigest()


def seal_inputs(directory, *, phase, source_root, provenance):
    root=Path(directory).resolve();source=Path(source_root).resolve()
    if phase not in ('cv','final'):raise ValueError('p6_batch_phase_invalid')
    if (not provenance.get('l3_identity') or not provenance.get('calendar_receipt_sha256')
            or not provenance.get('ancestor_graph_sha256')):raise ValueError('p6_batch_provenance_incomplete')
    for key in ('calendar_receipt_sha256','ancestor_graph_sha256'):
        value=provenance[key]
        if len(value)!=64 or any(c not in '0123456789abcdef' for c in value):raise ValueError('p6_batch_provenance_invalid')
    cutoff=TrainingCutoff(**provenance['requested_cutoff'])
    if phase=='cv':
        if {p.name for p in root.iterdir()}!={'1','2','3','4'}:raise ValueError('p6_batch_cv_directory_contract')
        folds=[_read_fold(root/str(f),cutoff) for f in range(1,5)]
        if [r['fold'] for r,_,_,_ in folds]!=[1,2,3,4]:raise ValueError('p6_batch_fold_identity')
        keys=[(r['date'],r['symbol']) for _,frame,_,_ in folds for r in frame.select('date','symbol').to_dicts()]
        if len(keys)!=len(set(keys)):raise ValueError('p6_batch_heldout_overlap')
    else:
        receipt=json.loads((root/'receipt.json').read_bytes())
        if (receipt.get('schema_version')!='p6-final-refit-inputs-v1' or receipt.get('recipe')!=recipe.RECIPE
                or receipt.get('checksum')!=digest({k:v for k,v in receipt.items() if k!='checksum'})
                or receipt.get('requested_cutoff')!=cutoff.__dict__ or receipt.get('outer_rows')!=0
                or receipt.get('epoch_reselection_allowed') is not False):raise ValueError('p6_batch_final_receipt')
        required={'source.json','arrays.npz','recipe.json','frozen-p-loss.json',*[f'seed{s}-selection.json' for s in (42,43,44)]}
        if not required<=set(receipt.get('files_sha256',{})):raise ValueError('p6_batch_final_files_incomplete')
        for name,checksum in receipt['files_sha256'].items():
            if Path(name).name!=name or _sha((root/name).read_bytes())!=checksum:raise ValueError('p6_batch_final_file_changed')
    # Retain the audited upstream version. New engine code gets a fresh source SHA.
    protocol=json.loads((source/'ml-controller/services/l4_r2_protocol.json').read_bytes())
    for name,checksum in protocol['upstream_files'].items():
        if _sha((source/'ml-service/vendor/tabpack'/name).read_bytes())!=checksum:raise ValueError('p6_batch_upstream_changed:'+name)
    code={'p6_train.py':'ml-service/app/p6_engine/p6_train.py',
        'r2_train.py':'ml-service/app/r2_engine/r2_train.py','r2_selection.py':'ml-service/app/r2_engine/r2_selection.py'}
    # Snapshot bytes once: manifest and ZIP must represent the same read.
    inputs={}
    for path in sorted(root.rglob('*')):
        if not path.is_file():continue
        if path.is_symlink() or not path.resolve().is_relative_to(root):raise ValueError('p6_batch_external_input')
        name=path.relative_to(root).as_posix()
        if name=='batch-seal.json':raise ValueError('p6_batch_already_sealed')
        inputs[name]=path.read_bytes()
    if phase=='final' and set(inputs)!=set(receipt['files_sha256'])|{'receipt.json'}:
        raise ValueError('p6_batch_final_unreferenced_files')
    body=dict(schema_version='p6-sealed-phase-v1',recipe=recipe.RECIPE,phase=phase,
        protocol=recipe.PROTOCOL,provenance=provenance,
        code_sha256={name:_sha((source/path).read_bytes()) for name,path in code.items()},
        upstream_commit=protocol['upstream_commit'],upstream_files=protocol['upstream_files'],
        files_sha256={name:_sha(raw) for name,raw in inputs.items()})
    seal={**body,'batch_id':digest(body)}
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
        for name,raw in {**inputs,'batch-seal.json':json.dumps(seal,sort_keys=True).encode()}.items():
            info=zipfile.ZipInfo(name);info.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(info,raw)
    return seal,output.getvalue()
