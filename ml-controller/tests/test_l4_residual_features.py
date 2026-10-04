import numpy as np
import pytest
from app.l4_residual_features import matrix, OUTPUTS
from test_l4_distribution import features


def test_residual_matrix_date_weights_and_frozen_recipe():
    rows=[{'date':d,'features':features()} for d in ['2026-09-01','2026-09-02','2026-09-02']]
    heads=[dict(zip(OUTPUTS,v)) for v in [[.3,.04,.02,.022],[.5,.02,.03,-.005],[.8,.1,.2,-.14]]]
    x,recipe=matrix(rows,heads)
    h=np.array([[p[k] for k in OUTPUTS] for p in heads])
    weights=np.array([.5,.25,.25])[:,None]
    mean=(weights*h).sum(0)
    scale=np.maximum(np.sqrt((weights*(h-mean)**2).sum(0)),.001)
    assert x.shape==(3,34)
    np.testing.assert_array_equal(x[:,30:],(h-mean)/scale)
    unseen=[dict(heads[0],expected_return_gross=1.)]
    out,frozen=matrix(rows[:1],unseen,recipe)
    assert frozen==recipe
    assert out[0,-1]==pytest.approx((1.-mean[-1])/scale[-1])


def test_nonfinite_heads_rejected():
    with pytest.raises(ValueError,match='nonfinite_training_matrix'):
        matrix([{'date':'2026-09-01','features':features()}],[dict.fromkeys(OUTPUTS,float('nan'))])
