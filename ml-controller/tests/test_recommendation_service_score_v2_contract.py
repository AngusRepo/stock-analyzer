from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_re_rank_recommendations_uses_score_v2_final_score_tiebreak() -> None:
    source = read("ml-controller/services/recommendation_service.py")
    start = source.index("def re_rank_recommendations")
    end = source.index("def merge_llm_reasons_into_recommendations", start)
    block = source[start:end]

    assert "ORDER BY rank ASC" in block
    assert "json_extract(score_components, '$.finalScore')" in block
    assert "json_extract(score_components, '$.total')" in block
    assert "ORDER BY rank ASC, score DESC" not in block
