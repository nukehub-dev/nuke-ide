"""Edge-case tests for build_chain helpers and the ENDF builder.

Covers the JSON fallback encoder, unnamed source nuclides, fission-yield
borrow parents on loaded chains, and the ENDF-mode build path against a
recording stub of openmc.deplete.Chain. No real chain data is read.
"""

import sys
import types
from types import SimpleNamespace

import build_chain
import pytest

# ---------------------------------------------------------------------------
# _json_safe
# ---------------------------------------------------------------------------


class _ArrayLike:
    def tolist(self):
        return [1, 2, 3]


def test_json_safe_uses_item_for_scalars():
    """Objects exposing item() (numpy scalars) are unwrapped."""
    assert build_chain._json_safe(SimpleNamespace(item=lambda: 2.5)) == 2.5


def test_json_safe_uses_tolist_for_array_like():
    """Objects without item() but with tolist() serialize their list."""
    assert build_chain._json_safe(_ArrayLike()) == [1, 2, 3]


def test_json_safe_handles_multi_element_numpy_arrays():
    """Multi-element arrays expose item() but must use tolist() first."""
    np = pytest.importorskip("numpy")
    assert build_chain._json_safe(np.array([1.0, 2.0])) == [1.0, 2.0]


def test_json_safe_falls_back_to_string():
    """Unknown objects are stringified rather than failing serialization."""
    assert build_chain._json_safe(object()).startswith("<object object at")


# ---------------------------------------------------------------------------
# Source-chain closure details
# ---------------------------------------------------------------------------


def test_fpy_closure_skips_unnamed_nuclides(tmp_path):
    """A <nuclide> without a name attribute is ignored, not indexed."""
    path = tmp_path / "chain.xml"
    path.write_text(
        "<depletion_chain>"
        "<nuclide><half_life>1.0</half_life></nuclide>"
        '<nuclide name="U235"><half_life>1.0</half_life></nuclide>'
        "</depletion_chain>"
    )

    assert build_chain.compute_fpy_closure(str(path), ["U235"]) == ({"U235"}, [])


def _nuc(name, decay_targets=(), reaction_targets=(), yield_products=None, fpy=None):
    nuc = SimpleNamespace(
        name=name,
        decay_modes=[("beta-", t, 1.0) for t in decay_targets],
        reactions=[SimpleNamespace(target=t) for t in reaction_targets],
        yield_data=SimpleNamespace(products=yield_products) if yield_products else None,
    )
    if fpy is not None:
        nuc._fpy = fpy
    return nuc


def test_target_closure_includes_borrow_parent_from_loaded_chain():
    """A chain loaded from ENDF/XML carries the FPY borrow parent in _fpy."""
    chain = SimpleNamespace(nuclides=[_nuc("U239", fpy="Pu241"), _nuc("Pu241"), _nuc("O16")])

    assert build_chain.compute_target_closure(chain, ["U239"]) == {"U239", "Pu241"}


# ---------------------------------------------------------------------------
# build_from_endf with a recording stub chain
# ---------------------------------------------------------------------------


class RecordingChain:
    instances = []

    def __init__(self, nuclides):
        self.nuclides = list(nuclides)
        self.exported_to = None
        RecordingChain.instances.append(self)

    def export_to_xml(self, path):
        self.exported_to = path


def _install_endf_chain(monkeypatch, nuclides):
    def from_endf(decay_files, fpy_files, neutron_files, progress):
        assert progress is False
        return RecordingChain(nuclides)

    fake_deplete = types.ModuleType("openmc.deplete")
    fake_deplete.Chain = SimpleNamespace(from_endf=from_endf)
    fake_openmc = types.ModuleType("openmc")
    fake_openmc.deplete = fake_deplete
    RecordingChain.instances = []
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.deplete", fake_deplete)


def _endf_dir(tmp_path, neutron_dir="neutron"):
    for sub in ("decay", "nfy", neutron_dir):
        directory = tmp_path / sub
        directory.mkdir(parents=True)
        (directory / "sample.endf").write_text("x")
    return tmp_path


def _args(tmp_path, **overrides):
    defaults = {
        "from_chain": None,
        "from_endf": None,
        "nuclides": None,
        "output": str(tmp_path / "built_chain.xml"),
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class TestBuildFromEndf:
    def test_full_build_exports_every_nuclide(self, monkeypatch, tmp_path, capsys):
        """Without --nuclides the built chain is exported unchanged."""
        _install_endf_chain(monkeypatch, [_nuc("U235"), _nuc("U238")])
        endf = _endf_dir(tmp_path)

        result = build_chain.build_chain(_args(tmp_path, from_endf=str(endf)))

        assert result == {
            "success": True,
            "mode": "endf",
            "nuclideCount": 2,
            "outputPath": str((tmp_path / "built_chain.xml").absolute()),
        }
        (chain,) = RecordingChain.instances
        assert chain.exported_to == str((tmp_path / "built_chain.xml").absolute())
        assert [n.name for n in chain.nuclides] == ["U235", "U238"]
        assert "2 nuclides" in capsys.readouterr().err

    def test_plural_neutrons_directory_is_accepted(self, monkeypatch, tmp_path):
        """ENDF-B-VII's neutrons/ layout is accepted like neutron/."""
        _install_endf_chain(monkeypatch, [_nuc("U235")])
        endf = _endf_dir(tmp_path, neutron_dir="neutrons")

        result = build_chain.build_chain(_args(tmp_path, from_endf=str(endf)))

        assert result["nuclideCount"] == 1

    def test_nuclide_filter_keeps_target_closure(self, monkeypatch, tmp_path):
        """--nuclides filters the built chain but keeps reaction targets."""
        _install_endf_chain(
            monkeypatch,
            [_nuc("U235", reaction_targets=["U236"]), _nuc("U236"), _nuc("O16")],
        )
        endf = _endf_dir(tmp_path)

        result = build_chain.build_chain(_args(tmp_path, from_endf=str(endf), nuclides="U235"))

        assert result["nuclideCount"] == 2
        assert [n.name for n in RecordingChain.instances[0].nuclides] == ["U235", "U236"]

    def test_unknown_filter_nuclide_raises(self, monkeypatch, tmp_path):
        """A requested nuclide missing from the built chain is reported."""
        _install_endf_chain(monkeypatch, [_nuc("U235")])
        endf = _endf_dir(tmp_path)

        with pytest.raises(ValueError, match="not present in built chain: Xx999"):
            build_chain.build_chain(_args(tmp_path, from_endf=str(endf), nuclides="Xx999"))

    def test_output_parent_directory_is_created(self, monkeypatch, tmp_path):
        """A nested output path gets its parent directories created."""
        _install_endf_chain(monkeypatch, [_nuc("U235")])
        endf = _endf_dir(tmp_path)
        output = tmp_path / "nested" / "deeper" / "chain.xml"

        result = build_chain.build_chain(_args(tmp_path, from_endf=str(endf), output=str(output)))

        assert result["outputPath"] == str(output.absolute())
        assert output.parent.is_dir()
