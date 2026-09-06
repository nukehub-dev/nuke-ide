"""Tests for in-CAD body material tags merged into the region manifest.

Covers the ``BodyDef.material`` → sidecar hop: document body dicts carrying
``label`` + ``material`` materialize as manifest volumes
``{"selector": <label>, "material": <tag>}`` via
:func:`region_manifest.document_material_volumes`, unless an explicit sidecar
entry already claims the selector.
"""

import pytest

from region_manifest import CURRENT_VERSION, RegionManifest, document_material_volumes


def _bodies():
    return [
        {"id": "body-1", "name": "Fuel", "label": "fuel", "material": "UO2"},
        {"id": "body-2", "name": "Clad", "label": "clad", "material": "Zircaloy"},
    ]


def test_tagged_doc_yields_selector_material_volumes() -> None:
    derived = document_material_volumes(_bodies())
    assert derived == [
        {"selector": "fuel", "material": "UO2"},
        {"selector": "clad", "material": "Zircaloy"},
    ]


def test_untagged_doc_yields_no_volumes() -> None:
    bodies = [
        {"id": "body-1", "name": "Base"},
        {"id": "body-2", "name": "Labeled", "label": "base"},
        {"id": "body-3", "name": "TaggedNoLabel", "material": "UO2"},
    ]
    assert document_material_volumes(bodies) == []
    assert document_material_volumes([]) == []
    assert document_material_volumes(None) == []


def test_explicit_sidecar_entry_wins() -> None:
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [{"selector": "fuel", "name": "fuel", "material": "MOX"}],
        }
    )
    derived = document_material_volumes(_bodies(), manifest)
    # The sidecar's explicit MOX entry for "fuel" stands; only "clad" derives.
    assert derived == [{"selector": "clad", "material": "Zircaloy"}]


def test_explicit_entry_wins_for_raw_dict_manifests() -> None:
    manifest = {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "clad", "material": "Zr"}],
    }
    derived = document_material_volumes(_bodies(), manifest)
    assert derived == [{"selector": "fuel", "material": "UO2"}]


def test_default_entry_does_not_suppress_doc_tags() -> None:
    """Only explicit selectors block derivation; default propagation is untouched."""
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [
                {
                    "selector": "template",
                    "name": "steel",
                    "material": "Steel",
                    "default": True,
                }
            ],
        }
    )
    derived = document_material_volumes(_bodies(), manifest)
    assert derived == [
        {"selector": "fuel", "material": "UO2"},
        {"selector": "clad", "material": "Zircaloy"},
    ]
    # And entry_for/default resolution itself is unchanged.
    assert manifest.entry_for("fuel")["material"] == "Steel"
    assert manifest.entry_for("fuel")["selector"] == "fuel"


def test_merged_manifest_parses_and_yields_material_links() -> None:
    """Contract fixture: explicit + derived volumes parse through RegionManifest
    and yield the ``{selector, material}`` pairs openmc-studio's importNukeCAD
    already consumes as ``materialLinks``."""
    sidecar = {
        "version": CURRENT_VERSION,
        "volumes": [{"selector": "fuel", "name": "fuel", "material": "MOX"}],
    }
    merged = {
        "version": CURRENT_VERSION,
        "volumes": [*sidecar["volumes"], *document_material_volumes(_bodies(), sidecar)],
    }
    manifest = RegionManifest.from_dict(merged)
    links = [
        {"selector": entry["selector"], "material": entry["material"]}
        for entry in manifest.volumes
        if entry.get("material")
    ]
    assert links == [
        {"selector": "fuel", "material": "MOX"},
        {"selector": "clad", "material": "Zircaloy"},
    ]
    # The importer's truthiness collection picks up both placeholder names.
    material_set = {entry["material"] for entry in manifest.volumes if entry.get("material")}
    assert material_set == {"MOX", "Zircaloy"}


def test_non_dict_bodies_and_empty_tags_skipped() -> None:
    bodies = [
        "not-a-body",
        {"id": "body-1", "name": "Empty", "label": "empty", "material": ""},
        {"id": "body-2", "name": "Blank", "label": "", "material": "UO2"},
        {"id": "body-3", "name": "Ok", "label": "ok", "material": "UO2"},
    ]
    assert document_material_volumes(bodies) == [{"selector": "ok", "material": "UO2"}]


def _tagged_pad_document(material="UO2"):
    """Minimal valid v3 document: one labeled body, one square pad."""
    points = [(0, 0), (5, 0), (5, 5), (0, 5)]
    primitives = [{"id": f"p{i}", "type": "point", "x": x, "y": y} for i, (x, y) in enumerate(points)]
    primitives += [
        {"id": f"l{i}", "type": "line", "p1_id": f"p{i}", "p2_id": f"p{(i + 1) % 4}"} for i in range(4)
    ]
    body = {"id": "b1", "label": "fuel"}
    if material is not None:
        body["material"] = material
    return {
        "version": 3,
        "name": "tag-build",
        "bodies": [body],
        "datums": [{"id": "xy", "kind": "XY"}],
        "sketches": [{"id": "s1", "name": "s", "datumId": "xy", "primitives": primitives}],
        "features": [
            {"id": "f1", "type": "pad", "body": "b1", "sketchId": "s1", "params": {"length": 10}}
        ],
        "curves": [],
    }


def test_build_document_writes_merged_sidecar() -> None:
    """Tagged doc build persists ``<stem>.regions.json`` with the derived entry."""
    build123d = pytest.importorskip("build123d")
    del build123d
    import json
    import tempfile
    from pathlib import Path

    from geometry_service import build_document

    with tempfile.TemporaryDirectory() as tmp:
        doc_path = Path(tmp) / "tagged.nuke-cad"
        doc_path.write_text(json.dumps(_tagged_pad_document()), encoding="utf-8")
        result = build_document(str(doc_path), output_dir=tmp, export_dagmc=False, export_mesh=False)
        assert result.get("success"), result.get("error")
        sidecar = Path(tmp) / "tagged.regions.json"
        assert sidecar.exists(), "tagged build must write the regions sidecar"
        volumes = json.loads(sidecar.read_text(encoding="utf-8"))["volumes"]
        assert {"selector": "fuel", "material": "UO2"} in volumes


def test_build_document_untagged_writes_no_sidecar() -> None:
    """Untagged doc build never touches the filesystem with a sidecar."""
    build123d = pytest.importorskip("build123d")
    del build123d
    import json
    import tempfile
    from pathlib import Path

    from geometry_service import build_document

    with tempfile.TemporaryDirectory() as tmp:
        doc_path = Path(tmp) / "plain.nuke-cad"
        doc_path.write_text(json.dumps(_tagged_pad_document(material=None)), encoding="utf-8")
        result = build_document(str(doc_path), output_dir=tmp, export_dagmc=False, export_mesh=False)
        assert result.get("success"), result.get("error")
        assert not (Path(tmp) / "plain.regions.json").exists()
