"""Tests for the advanced depletion options in run_depletion (W6).

Covers argparse wiring for the new flags, load_flux_file, and
build_independent_operator with a fake openmc module (no real openmc needed).
"""

import json
import sys
import types

import numpy as np
import pytest
import run_depletion


class _FakeMicroXS:
    @classmethod
    def from_csv(cls, path):
        return ("MicroXS", path)


class _FakeIndependentOperator:
    def __init__(self, materials, fluxes, micros, chain, **kwargs):
        self.materials = materials
        self.fluxes = fluxes
        self.micros = micros
        self.chain = chain
        self.kwargs = kwargs


class _FakeDeplete:
    MicroXS = _FakeMicroXS
    IndependentOperator = _FakeIndependentOperator

    @staticmethod
    def get_microxs_and_flux(model, domains, chain_file=None):
        return (["flux", len(domains)], ["micro", len(domains)])


class _FakeOpenMC(types.ModuleType):
    def __init__(self):
        super().__init__("openmc")
        self.deplete = _FakeDeplete()


class _FakeMaterial:
    def __init__(self, material_id, depletable=True):
        self.id = material_id
        self.depletable = depletable


def _args(**overrides):
    """Build an argparse-like namespace with the defaults build_independent_operator needs."""
    args = types.SimpleNamespace(
        flux_files=None,
        microxs_files=None,
        generate_microxs=False,
        normalization="fission-q",
    )
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


class TestLoadFluxFile:
    def test_loads_npy(self, tmp_path):
        """A .npy file loads as a numpy array."""
        arr = np.array([1.0, 2.0, 3.0])
        path = tmp_path / "flux.npy"
        np.save(path, arr)
        loaded = run_depletion.load_flux_file(str(path))
        assert isinstance(loaded, np.ndarray)
        assert loaded.tolist() == [1.0, 2.0, 3.0]

    def test_loads_csv(self, tmp_path):
        """A .csv file loads via comma delimiter."""
        path = tmp_path / "flux.csv"
        path.write_text("1.0,2.0,3.0\n")
        loaded = run_depletion.load_flux_file(str(path))
        assert loaded.tolist() == [1.0, 2.0, 3.0]

    def test_loads_whitespace_text(self, tmp_path):
        """A whitespace-separated text file loads with no delimiter."""
        path = tmp_path / "flux.txt"
        path.write_text("1.0 2.0 3.0\n")
        loaded = run_depletion.load_flux_file(str(path))
        assert loaded.tolist() == [1.0, 2.0, 3.0]


class TestBuildIndependentOperator:
    def test_requires_depletable_material(self, monkeypatch):
        """No depletable materials raises ValueError."""
        monkeypatch.setitem(sys.modules, "openmc", _FakeOpenMC())
        with pytest.raises(ValueError, match="depletable material"):
            run_depletion.build_independent_operator(
                _args(), model=None, materials=[], chain=None, fission_q=None
            )

    def test_file_count_mismatch_raises(self, monkeypatch):
        """Mismatched flux/microxs file counts raise ValueError."""
        monkeypatch.setitem(sys.modules, "openmc", _FakeOpenMC())
        mats = [_FakeMaterial(1), _FakeMaterial(2)]
        args = _args(flux_files="a.npy", microxs_files="a.csv,b.csv")
        with pytest.raises(ValueError, match="one flux file and one MicroXS file"):
            run_depletion.build_independent_operator(
                args, model=None, materials=mats, chain=None, fission_q=None
            )

    def test_generate_microxs_path(self, monkeypatch):
        """--generate-microxs uses get_microxs_and_flux with depletable domains."""
        fake = _FakeOpenMC()
        monkeypatch.setitem(sys.modules, "openmc", fake)
        mats = [_FakeMaterial(1), _FakeMaterial(2), _FakeMaterial(3, depletable=False)]
        op = run_depletion.build_independent_operator(
            _args(generate_microxs=True, normalization="source-rate"),
            model="model",
            materials=mats,
            chain="chain",
            fission_q={"U235": 2.0e8},
        )
        assert isinstance(op, _FakeIndependentOperator)
        assert op.fluxes == ["flux", 2]
        assert op.micros == ["micro", 2]
        assert op.chain == "chain"
        assert op.kwargs["normalization_mode"] == "source-rate"
        assert op.kwargs["fission_q"] == {"U235": 2.0e8}


class TestMainArgparseAdvanced:
    def _run_main_with_stub(self, monkeypatch, tmp_path, extra_argv):
        """Run main() with run_depletion stubbed; returns (parsed args, stdout result)."""
        captured = {}

        def stub(args):
            captured["args"] = args
            return {"success": True}

        monkeypatch.setattr(run_depletion, "run_depletion", stub)
        monkeypatch.setattr(
            sys, "argv", ["run_depletion.py", str(tmp_path), "--time-steps", "1"] + extra_argv
        )
        run_depletion.main()
        return captured["args"]

    def test_diff_burnable_mats_flags(self, monkeypatch, tmp_path):
        """--diff-burnable-mats and --diff-volume-method parse correctly."""
        args = self._run_main_with_stub(
            monkeypatch, tmp_path, ["--diff-burnable-mats", "--diff-volume-method", "match cell"]
        )
        assert args.diff_burnable_mats is True
        assert args.diff_volume_method == "match cell"

    def test_invalid_diff_volume_method_exits_with_code_2(self, monkeypatch, tmp_path):
        """An invalid --diff-volume-method is rejected by argparse."""
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_depletion.py",
                str(tmp_path),
                "--time-steps",
                "1",
                "--diff-volume-method",
                "bogus",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_depletion.main()
        assert exc.value.code == 2

    def test_transfer_rates_and_fission_q_json_parsing(self, monkeypatch, tmp_path):
        """--transfer-rates and --fission-q reach the run function as raw JSON strings."""
        transfer_rates = json.dumps(
            [{"material": 1, "element": "U", "rate": 1e-5, "destinationMaterial": 2}]
        )
        fission_q = json.dumps({"U235": 2.02e8})
        args = self._run_main_with_stub(
            monkeypatch, tmp_path, ["--transfer-rates", transfer_rates, "--fission-q", fission_q]
        )
        assert json.loads(args.transfer_rates)[0]["element"] == "U"
        assert json.loads(args.fission_q)["U235"] == 2.02e8

    def test_generate_microxs_and_files(self, monkeypatch, tmp_path):
        """--generate-microxs and file list flags parse correctly."""
        args = self._run_main_with_stub(
            monkeypatch,
            tmp_path,
            [
                "--operator",
                "independent",
                "--generate-microxs",
                "--flux-files",
                "a.npy,b.npy",
                "--microxs-files",
                "a.csv,b.csv",
            ],
        )
        assert args.operator == "independent"
        assert args.generate_microxs is True
        assert args.flux_files == "a.npy,b.npy"
        assert args.microxs_files == "a.csv,b.csv"


class TestOpenMCIntegration:
    def test_operator_signatures_accept_new_kwargs(self):
        """The real operator constructors accept the kwargs the script passes."""
        openmc = pytest.importorskip("openmc")
        import inspect

        coupled_params = inspect.signature(openmc.deplete.CoupledOperator.__init__).parameters
        for expected in (
            "diff_burnable_mats",
            "diff_volume_method",
            "normalization_mode",
            "fission_q",
        ):
            assert expected in coupled_params

        independent_params = inspect.signature(
            openmc.deplete.IndependentOperator.__init__
        ).parameters
        for expected in (
            "materials",
            "fluxes",
            "micros",
            "chain_file",
            "normalization_mode",
            "fission_q",
        ):
            assert expected in independent_params

        transfer_params = inspect.signature(openmc.deplete.Integrator.add_transfer_rate).parameters
        for expected in (
            "material",
            "components",
            "transfer_rate",
            "transfer_rate_units",
            "destination_material",
        ):
            assert expected in transfer_params
