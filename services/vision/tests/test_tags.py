import pytest
from warewise_contracts import ItemTags

from app.schemas import parse_tagger_output
from app.tags import extract_json, to_item_tags

REPLY = {"is_clothing": True, "item_count": 1, "category": "top", "subcategory": " Kurta ",
         "colors": ["Mustard", "teal", "white", "mustard"], "pattern": "paisley", "seasons": ["Summer", "spring"],
         "fabric": "", "formality": "3", "fit": "boxy", "brand": None, "confidence": 1.7}


def test_keeps_known_drops_unknown_coerces():
    t = parse_tagger_output(REPLY)
    assert (t.subcategory, t.colors, t.pattern, t.seasons, t.formality, t.fit, t.confidence) == (
        "kurta", ["mustard", "white", "mustard"], "other", ["summer"], 3, "regular", 0.5)


def test_seasons_fall_back_to_all():
    assert parse_tagger_output({**REPLY, "seasons": ["spring"]}).seasons == ["all"]


def test_invalid_output_names_the_problem():
    with pytest.raises(ValueError, match="category"):
        parse_tagger_output({**REPLY, "category": "hat"})
    with pytest.raises(ValueError, match="formality"):
        parse_tagger_output({**REPLY, "formality": 9})
    with pytest.raises(ValueError, match="is_clothing"):
        parse_tagger_output({**REPLY, "is_clothing": "yes"})


def test_maps_to_contract_item_tags():
    tags = to_item_tags(parse_tagger_output(REPLY), "local-vision")
    assert ItemTags.model_validate(tags.to_json()).to_json() == {
        "category": "top", "subcategory": "kurta", "colors": ["mustard", "white"], "pattern": "other",
        "seasons": ["summer"], "fabric": None, "formality": 3, "fit": "regular", "brand": None,
        "confidence": 0.5, "model": "local-vision"}


def test_confidence_rounds_half_up_like_javascript():
    assert to_item_tags(parse_tagger_output({**REPLY, "confidence": 0.125}), "m").confidence == 0.13


def test_extract_json():
    assert extract_json('Sure! ```json\n{"a":1}\n``` hope that helps') == {"a": 1}
    assert extract_json("no json here") is None
