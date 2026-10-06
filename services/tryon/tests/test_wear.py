from app.wear import slot_for


def test_shirt_filed_under_layers_is_a_top_and_real_layers_stay():
    assert slot_for("outer", "linen shirt") == "top"
    assert slot_for("outer", "blazer") == "outer"
    assert slot_for("outer", None) == "outer"


def test_ignores_accessories_and_unknown_categories():
    assert slot_for("accessory", "watch") is None
    assert slot_for(None, None) is None
    assert slot_for("bottom", "jeans") == "bottom"
