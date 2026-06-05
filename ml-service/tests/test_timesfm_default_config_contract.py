from app.timesfm_universal import DEFAULT_MODEL_ID, DEFAULT_PRED_LEN, DEFAULT_SEQ_LEN, _default_config


def test_timesfm_default_zero_shot_config_is_real_runtime_config():
    config = _default_config("v1")

    assert config["model_id"] == DEFAULT_MODEL_ID
    assert config["seq_len"] == DEFAULT_SEQ_LEN
    assert config["pred_len"] == DEFAULT_PRED_LEN
    assert config["source"] == "timesfm_default_zero_shot_config"
