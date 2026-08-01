"""Tests for build_chain (depletion chain builder driver).

The FPY-borrow closure is pure stdlib and tested against a synthetic chain
XML. Builder modes run against recording stubs of openmc.deplete.Chain so no
real chain build executes. The only test touching real OpenMC is the
importorskip signature check at the end.
"""

import json
import sys
import types
from types import SimpleNamespace

import build_chain
import pytest

SYNTHETIC_CHAIN = """<?xml version='1.0' encoding='utf-8'?>
<depletion_chain>
  <nuclide name="U235"><half_life>1.0</half_life></nuclide>
  <nuclide name="U238"><half_life>1.0</half_life></nuclide>
  <nuclide name="U239">
    <half_life>1.0</half_life>
    <neutron_fission_yields parent="Pu241"/>
  </nuclide>
  <nuclide name="Pu241"><half_life>1.0</half_life></nuclide>
  <nuclide name="Np239">
    <half_life>1.0</half_life>
    <neutron_fission_yields parent="Pu240"/>
  </nuclide>
  <nuclide name="Pu240"><half_life>1.0</half_life></nuclide>
  <nuclide name="O16"><half_life>1.0</half_life></nuclide>
</depletion_chain>
"""


@pytest.fixture()
def chain_xml(tmp_path):
    path = tmp_path / "chain.xml"
    path.write_text(SYNTHETIC_CHAIN)
    return str(path)


# ---------------------------------------------------------------------------
# compute_fpy_closure (pure stdlib)
# ---------------------------------------------------------------------------


def test_closure_passthrough_without_borrowers(chain_xml):
    resolved, added = build_chain.compute_fpy_closure(chain_xml, ["U235", "U238"])
    assert resolved == {"U235", "U238"}
    assert added == []


def test_closure_pulls_borrow_parent(chain_xml):
    resolved, added = build_chain.compute_fpy_closure(chain_xml, ["U235", "U239"])
    assert resolved == {"U235", "U239", "Pu241"}
    assert added == ["Pu241"]


def test_closure_resolves_transitively(chain_xml):
    # Np239 borrows from Pu240; Pu240 has no parent itself
    resolved, added = build_chain.compute_fpy_closure(chain_xml, ["Np239"])
    assert resolved == {"Np239", "Pu240"}
    assert added == ["Pu240"]


def test_closure_rejects_unknown_nuclide(chain_xml):
    with pytest.raises(ValueError, match="not present in source chain"):
        build_chain.compute_fpy_closure(chain_xml, ["Xx999"])


# ---------------------------------------------------------------------------
# compute_target_closure
# ---------------------------------------------------------------------------


def _nuc(name, decay_targets=(), reaction_targets=(), yield_products=None):
    return SimpleNamespace(
        name=name,
        decay_modes=[("beta-", t, 1.0) for t in decay_targets],
        reactions=[SimpleNamespace(target=t) for t in reaction_targets],
        yield_data=SimpleNamespace(products=yield_products) if yield_products else None,
    )


def test_target_closure_walks_decay_and_reaction_targets():
    chain = SimpleNamespace(
        nuclides=[
            _nuc("U235", reaction_targets=["U236"]),
            _nuc("U236", decay_targets=["Th232"]),
            _nuc("Th232"),
            _nuc("O16"),
        ]
    )
    resolved = build_chain.compute_target_closure(chain, ["U235"])
    assert resolved == {"U235", "U236", "Th232"}


def test_target_closure_ignores_targets_outside_chain():
    chain = SimpleNamespace(nuclides=[_nuc("U235", reaction_targets=["U236"])])
    resolved = build_chain.compute_target_closure(chain, ["U235"])
    assert resolved == {"U235"}


def test_target_closure_includes_fission_yield_products():
    chain = SimpleNamespace(
        nuclides=[
            _nuc("U235", yield_products=["Ag109", "Xe135"]),
            _nuc("Ag109"),
            _nuc("Xe135"),
        ]
    )
    resolved = build_chain.compute_target_closure(chain, ["U235"])
    assert resolved == {"U235", "Ag109", "Xe135"}


# ---------------------------------------------------------------------------
# build_subset with recording stub Chain
# ---------------------------------------------------------------------------


class RecordingChain:
    instances = []

    def __init__(self, nuclides):
        self.nuclides = nuclides
        self.exported_to = None
        RecordingChain.instances.append(self)

    def export_to_xml(self, path):
        self.exported_to = path


def _install_fake_deplete(monkeypatch, nuclide_names):
    fake_deplete = types.ModuleType("openmc.deplete")
    names = list(nuclide_names)
    fake_deplete.Chain = SimpleNamespace(
        from_xml=lambda path: RecordingChain(
            [SimpleNamespace(name=n, decay_modes=[], reactions=[], yield_data=None) for n in names]
        )
    )
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.deplete = fake_deplete
    RecordingChain.instances = []
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.deplete", fake_deplete)
    return fake_deplete


def _args(tmp_path, **overrides):
    defaults = {
        "from_chain": None,
        "from_endf": None,
        "nuclides": None,
        "output": str(tmp_path / "out_chain.xml"),
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_build_subset_filters_and_exports(monkeypatch, tmp_path, chain_xml):
    _install_fake_deplete(monkeypatch, ["U235", "U238", "U239", "Pu241", "O16"])
    args = _args(tmp_path, from_chain=chain_xml, nuclides="U235,U239")

    result = build_chain.build_chain(args)

    assert result["success"] is True
    assert result["mode"] == "subset"
    assert result["nuclideCount"] == 3  # U235, U239 + borrow parent Pu241
    assert result["sourceNuclideCount"] == 5
    assert result["borrowParentsIncluded"] == ["Pu241"]
    assert result["outputPath"].endswith("out_chain.xml")
    kept = [n.name for n in RecordingChain.instances[0].nuclides]
    assert kept == ["U235", "U239", "Pu241"]


def test_build_subset_keeps_all_without_nuclide_list(monkeypatch, tmp_path, chain_xml):
    _install_fake_deplete(monkeypatch, ["U235", "U238"])
    args = _args(tmp_path, from_chain=chain_xml)

    result = build_chain.build_chain(args)
    assert result["nuclideCount"] == 2
    assert result["borrowParentsIncluded"] == []


def test_build_subset_missing_source(tmp_path):
    args = _args(tmp_path, from_chain=str(tmp_path / "nope.xml"))
    with pytest.raises(FileNotFoundError, match="Source chain not found"):
        build_chain.build_chain(args)


def test_build_requires_a_mode(tmp_path):
    with pytest.raises(ValueError, match="required"):
        build_chain.build_chain(_args(tmp_path))


def test_build_rejects_both_modes(tmp_path, chain_xml):
    args = _args(tmp_path, from_chain=chain_xml, from_endf=str(tmp_path))
    with pytest.raises(ValueError, match="only one"):
        build_chain.build_chain(args)


# ---------------------------------------------------------------------------
# ENDF mode (structure validation only — no real ENDF data needed)
# ---------------------------------------------------------------------------


def test_endf_mode_requires_endf_directory(tmp_path):
    args = _args(tmp_path, from_endf=str(tmp_path / "no-such-dir"))
    with pytest.raises(FileNotFoundError, match="ENDF directory not found"):
        build_chain.build_chain(args)


def test_endf_mode_requires_sub_libraries(tmp_path):
    for sub in ("decay", "nfy"):  # neutron/ intentionally absent
        (tmp_path / sub).mkdir()
        (tmp_path / sub / "file.endf").write_text("x")
    args = _args(tmp_path, from_endf=str(tmp_path))
    with pytest.raises(FileNotFoundError, match="No ENDF neutron files"):
        build_chain.build_chain(args)


# ---------------------------------------------------------------------------
# main() CLI contract
# ---------------------------------------------------------------------------


def test_main_success_and_error_json(monkeypatch, tmp_path, chain_xml, capsys):
    _install_fake_deplete(monkeypatch, ["U235", "U238"])
    out = tmp_path / "out.xml"
    monkeypatch.setattr(
        sys, "argv", ["build_chain.py", "--from-chain", chain_xml, "--output", str(out)]
    )
    assert build_chain.main() == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["success"] is True and payload["nuclideCount"] == 2

    monkeypatch.setattr(sys, "argv", ["build_chain.py", "--output", str(out)])
    assert build_chain.main() == 1
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["success"] is False


def test_main_requires_output(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["build_chain.py", "--from-chain", "x.xml"])
    with pytest.raises(SystemExit):
        build_chain.main()


# ---------------------------------------------------------------------------
# Integration: real OpenMC API surface (skipped when openmc is absent)
# ---------------------------------------------------------------------------


def test_chain_api_surface_matches_builder_assumptions():
    pytest.importorskip("openmc")
    import inspect

    import openmc.deplete

    params = inspect.signature(openmc.deplete.Chain.from_endf).parameters
    assert list(params)[:3] == ["decay_files", "fpy_files", "neutron_files"]
    assert hasattr(openmc.deplete.Chain, "from_xml")
    assert hasattr(openmc.deplete.Chain, "export_to_xml")
