import polars as pl
import pytest
from app.feature_data_quality import require_technical_source_observations

FEATURES=("l1_diTrend","tech_adx_14","tech_sar")
def frame():return pl.DataFrame({"_source_missing__"+k:[True]*19+[False]*41 for k in FEATURES})
def test_original_twenty_bar_warmup_allowed():
    require_technical_source_observations(frame(),"2330")
@pytest.mark.parametrize("feature",FEATURES)
def test_finite_neutral_imputation_cannot_mask_missing_source(feature):
    df=frame().with_columns(pl.lit(True).alias("_source_missing__"+feature),pl.lit(0.).alias(feature))
    with pytest.raises(ValueError,match="technical_source_missing:2330:"+feature):require_technical_source_observations(df,"2330")
def test_missing_quality_mask_rejected():
    with pytest.raises(ValueError,match="technical_source_missing"):
        require_technical_source_observations(frame().drop("_source_missing__tech_sar"),"2330")
