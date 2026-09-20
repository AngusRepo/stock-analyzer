"""Pure immutable TimeXer metadata contract shared with the inference service."""
OFFICIAL_COMMIT = '76011909357972bd55a27adba2e1be994d81b327'
SCHEMA = 'stockvision-official-timexer-v1'
SCORE_SEMANTIC = 'forecast-t5-over-signal-close-gross-v1'
ARCHITECTURE = {'seq_len':168, 'patch_len':24, 'pred_len':5, 'd_model':512,
    'd_ff':512, 'e_layers':3, 'n_heads':8, 'dropout':.1, 'use_norm':True}


def metadata_contract(metadata):
    config = metadata.get('timexer') or {}
    if (metadata.get('schema_version') != SCHEMA+'-metadata'
            or config.get('variant') not in ('price','exo137')
            or config.get('official_commit') != OFFICIAL_COMMIT
            or config.get('architecture') != ARCHITECTURE
            or config.get('inference_device') != 'cuda'
            or config.get('matmul_precision') != 'high'
            or config.get('feature_history_schema') != 'formal137-pit-asof-source-quality-v3'
            or config.get('max_exogenous_staleness_sessions') != 1
            or metadata.get('raw_score_semantic_version') != SCORE_SEMANTIC
            or metadata.get('seq_len') != 168 or metadata.get('pred_len') != 5):
        raise ValueError('timexer_artifact_contract_invalid')
    return dict(config)
