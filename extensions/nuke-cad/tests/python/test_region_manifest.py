"""Tests for the region manifest parser/validator."""

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
