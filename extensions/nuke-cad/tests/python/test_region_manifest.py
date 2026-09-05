"""Tests for the region manifest parser/validator."""

import json
from pathlib import Path

import pytest
from region_manifest import CURRENT_VERSION, ManifestValidationError, RegionManifest


def test_empty_manifest() -> None:
    manifest = RegionManifest.from_dict({"version": CURRENT_VERSION})
    assert manifest.volumes == []
    assert manifest.surfaces == []


def test_valid_volume_and_surface() -> None:
    data = {
        "version": CURRENT_VERSION,
        "volumes": [
            {"selector": "fuel_pin", "name": "fuel", "material": "UO2", "tags": ["depletable"]}
        ],
        "surfaces": [{"selector": "clad.outer", "name": "clad_outer", "role": "boundary"}],
    }
    manifest = RegionManifest.from_dict(data)
    assert manifest.volumes == data["volumes"]
    assert manifest.surfaces == data["surfaces"]


def test_missing_selector_raises() -> None:
    with pytest.raises(ManifestValidationError, match="missing required 'selector'"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "volumes": [{"name": "fuel"}]})


def test_invalid_version_raises() -> None:
    with pytest.raises(ManifestValidationError, match="Unsupported manifest version"):
        RegionManifest.from_dict({"version": 999})


def test_duplicate_names_detected() -> None:
    data = {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "a", "name": "shared"}],
        "surfaces": [{"selector": "b", "name": "shared"}],
    }
    manifest = RegionManifest.from_dict(data)
    assert manifest.duplicate_names() == ["shared"]


def test_unknown_selectors() -> None:
    data = {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "known"}, {"selector": "unknown"}],
    }
    manifest = RegionManifest.from_dict(data)
    assert manifest.unknown_selectors({"known"}) == ["unknown"]


def test_missing_material_volumes() -> None:
    data = {
        "version": CURRENT_VERSION,
        "volumes": [
            {"selector": "fueled", "material": "UO2"},
            {"selector": "void"},
        ],
    }
    manifest = RegionManifest.from_dict(data)
    assert manifest.missing_material_volumes() == ["void"]


def test_mesh_size_field() -> None:
    data = {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "fuel_pin", "meshSize": 0.5}],
    }
    manifest = RegionManifest.from_dict(data)
    assert manifest.volumes[0]["meshSize"] == 0.5


def test_invalid_mesh_size_raises() -> None:
    with pytest.raises(ManifestValidationError, match="meshSize must be a number"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "volumes": [{"selector": "fuel_pin", "meshSize": "fine"}]}
        )


def test_non_dict_manifest_raises() -> None:
    with pytest.raises(ManifestValidationError, match="must be a JSON object"):
        RegionManifest.from_dict(["not", "a", "dict"])


def test_volumes_not_a_list_raises() -> None:
    with pytest.raises(ManifestValidationError, match="'volumes' must be a list"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "volumes": {"selector": "a"}})


def test_surfaces_not_a_list_raises() -> None:
    with pytest.raises(ManifestValidationError, match="'surfaces' must be a list"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "surfaces": "clad.outer"})


def test_entry_not_an_object_raises() -> None:
    with pytest.raises(ManifestValidationError, match=r"volumes\[0\] must be an object"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "volumes": ["fuel"]})


def test_non_string_selector_raises() -> None:
    with pytest.raises(ManifestValidationError, match="missing required 'selector'"):
        RegionManifest.from_dict({"version": CURRENT_VERSION, "volumes": [{"selector": 7}]})


def test_name_not_a_string_raises() -> None:
    with pytest.raises(ManifestValidationError, match="name must be a string"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "volumes": [{"selector": "a", "name": 1}]}
        )


def test_material_not_a_string_raises() -> None:
    with pytest.raises(ManifestValidationError, match="material must be a string"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "volumes": [{"selector": "a", "material": 1}]}
        )


def test_tags_not_a_list_raises() -> None:
    with pytest.raises(ManifestValidationError, match="tags must be a list"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "volumes": [{"selector": "a", "tags": "depletable"}]}
        )


def test_surface_role_not_a_string_raises() -> None:
    with pytest.raises(ManifestValidationError, match="role must be a string"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "surfaces": [{"selector": "s", "role": 1}]}
        )


def test_from_file_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "model.regions.json"
    data = {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "fuel_pin", "name": "fuel", "material": "UO2"}],
        "surfaces": [{"selector": "clad.outer", "name": "clad_outer"}],
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    manifest = RegionManifest.from_file(path)
    assert manifest.volumes == data["volumes"]
    assert manifest.surfaces == data["surfaces"]


def test_from_file_accepts_str_path(tmp_path: Path) -> None:
    path = tmp_path / "model.regions.json"
    path.write_text(json.dumps({"version": CURRENT_VERSION}), encoding="utf-8")
    manifest = RegionManifest.from_file(str(path))
    assert manifest.volumes == []


def test_from_file_invalid_json_raises(tmp_path: Path) -> None:
    path = tmp_path / "broken.regions.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ManifestValidationError, match="Invalid JSON"):
        RegionManifest.from_file(path)


def test_from_file_missing_raises(tmp_path: Path) -> None:
    with pytest.raises(ManifestValidationError, match="Cannot read manifest"):
        RegionManifest.from_file(tmp_path / "missing.regions.json")


def test_from_file_invalid_schema_raises(tmp_path: Path) -> None:
    path = tmp_path / "bad.regions.json"
    path.write_text(json.dumps({"version": 999}), encoding="utf-8")
    with pytest.raises(ManifestValidationError, match="Unsupported manifest version"):
        RegionManifest.from_file(path)


def test_to_dict_normalizes_missing_sections() -> None:
    manifest = RegionManifest.from_dict(
        {"version": CURRENT_VERSION, "volumes": [{"selector": "a"}]}
    )
    assert manifest.to_dict() == {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "a"}],
        "surfaces": [],
    }


def test_volume_and_surface_names_skip_unnamed() -> None:
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [{"selector": "a", "name": "fuel"}, {"selector": "b"}],
            "surfaces": [{"selector": "c", "name": "clad_outer"}, {"selector": "d"}],
        }
    )
    assert manifest.volume_names() == {"fuel"}
    assert manifest.surface_names() == {"clad_outer"}


def test_material_id_and_parent_id_accepted() -> None:
    data = {
        "version": CURRENT_VERSION,
        "volumes": [
            {
                "selector": "fuel",
                "name": "fuel",
                "material": "UO2",
                "materialId": "11111111-1111-4111-8111-111111111111",
                "parentId": "22222222-2222-4222-8222-222222222222",
            }
        ],
    }
    manifest = RegionManifest.from_dict(data)
    assert manifest.material_id_for("fuel") == "11111111-1111-4111-8111-111111111111"
    assert manifest.parent_id_for("fuel") == "22222222-2222-4222-8222-222222222222"


def test_material_id_must_be_a_string() -> None:
    with pytest.raises(ManifestValidationError, match="materialId must be a string"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "volumes": [{"selector": "a", "materialId": 7}]}
        )


def test_parent_id_must_be_a_string() -> None:
    with pytest.raises(ManifestValidationError, match="parentId must be a string"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "volumes": [{"selector": "a", "parentId": ["x"]}]}
        )


def test_default_must_be_a_boolean() -> None:
    with pytest.raises(ManifestValidationError, match="default must be a boolean"):
        RegionManifest.from_dict(
            {"version": CURRENT_VERSION, "volumes": [{"selector": "a", "default": "yes"}]}
        )


def test_legacy_manifest_without_new_fields_stays_valid() -> None:
    """Additive fields only: a version-1 manifest without UUIDs still reads."""
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [{"selector": "fuel", "name": "fuel", "material": "UO2"}],
        }
    )
    assert manifest.material_id_for("fuel") is None
    assert manifest.parent_id_for("fuel") is None
    assert manifest.default_entry() is None
    assert manifest.entry_for("fuel") is not None
    assert manifest.entry_for("unknown") is None


def test_default_entry_resolves_for_unlisted_selectors() -> None:
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [
                {
                    "selector": "template",
                    "name": "steel",
                    "material": "Steel",
                    "materialId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "default": True,
                },
                {"selector": "fuel", "name": "fuel", "material": "UO2"},
            ],
        }
    )
    # Explicit entries win over the default.
    assert manifest.entry_for("fuel")["material"] == "UO2"
    # Unlisted selectors inherit the default under their own selector.
    resolved = manifest.entry_for("coil_3")
    assert resolved is not None
    assert resolved["selector"] == "coil_3"
    assert resolved["material"] == "Steel"
    assert manifest.material_id_for("coil_3") == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    # Provenance: the copy records the default's material UUID as its parent.
    assert manifest.parent_id_for("coil_3") == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def test_copy_entries_propagate_with_parent_link() -> None:
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [
                {
                    "selector": "coil",
                    "name": "coil",
                    "material": "Copper",
                    "materialId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "tags": ["conductor"],
                }
            ],
        }
    )
    copies = manifest.copy_entries("coil", ["coil_1", "coil_2"])
    assert len(copies) == 2
    assert copies[0]["selector"] == "coil_1"
    assert copies[0]["material"] == "Copper"
    assert copies[0]["materialId"] == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    assert copies[0]["parentId"] == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    assert copies[0]["tags"] == ["conductor"]
    # Unknown sources propagate to nothing; the manifest itself is untouched.
    assert manifest.copy_entries("ghost", ["ghost_1"]) == []
    assert len(manifest.volumes) == 1
