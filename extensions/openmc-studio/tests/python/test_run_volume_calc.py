"""Tests for run_volume_calc: vector parsing, log_progress, and main() argparse wiring.

The real volume calculation (openmc) is never exercised here; main() is
tested with run_volume_calc.run_volume_calc replaced by a stub, and argparse
error paths raise SystemExit before any openmc import happens.
"""

import json
import sys

import pytest
import run_volume_calc


class TestLogProgress:
    def test_writes_message_to_stderr(self, capsys):
        """log_progress prints the bare message to stderr, not stdout."""
        run_volume_calc.log_progress("sampling")
        captured = capsys.readouterr()
        assert captured.err == "sampling\n"
        assert captured.out == ""

    def test_writes_multiple_lines(self, capsys):
        """Each call appends one line to stderr."""
        run_volume_calc.log_progress("a")
        run_volume_calc.log_progress("b")
        assert capsys.readouterr().err == "a\nb\n"


class TestParseVector:
    def test_parses_three_comma_separated_values(self):
        """A well-formed vector string parses to three floats."""
        assert run_volume_calc._parse_vector("-10,-5.5,2e3") == [-10.0, -5.5, 2000.0]

    def test_rejects_wrong_length(self):
        """A vector with the wrong number of components raises ValueError."""
        with pytest.raises(ValueError):
            run_volume_calc._parse_vector("1,2")

    def test_rejects_non_numeric(self):
        """A non-numeric component raises ValueError."""
        with pytest.raises(ValueError):
            run_volume_calc._parse_vector("1,x,3")


class TestMainArgparse:
    def test_no_arguments_exits_with_code_2(self, monkeypatch):
        """Missing working_directory and required flags is an argparse error."""
        monkeypatch.setattr(sys, "argv", ["run_volume_calc.py"])
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 2

    def test_missing_required_flags_exits_with_code_2(self, monkeypatch):
        """--domain-type, --domain-ids, and --samples are all required."""
        monkeypatch.setattr(sys, "argv", ["run_volume_calc.py", "/tmp"])
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 2

    def test_invalid_domain_type_exits_with_code_2(self, monkeypatch):
        """An unknown --domain-type is rejected by argparse choices."""
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                "/tmp",
                "--domain-type",
                "bogus",
                "--domain-ids",
                "1",
                "--samples",
                "100",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 2

    def test_missing_working_directory_returns_json_error(self, monkeypatch, capsys):
        """A nonexistent working directory yields a JSON error object, exit 0."""
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                "/nonexistent-dir-xyz",
                "--domain-type",
                "cell",
                "--domain-ids",
                "1",
                "--samples",
                "100",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "not found" in result["error"].lower()

    def test_success_path_prints_single_json_object(self, monkeypatch, capsys, tmp_path):
        """main() prints exactly one JSON object with the stubbed run results."""
        expected = {
            "success": True,
            "results": [{"id": 1, "volume": 42.0, "stdDev": 0.1, "atoms": {}}],
        }
        monkeypatch.setattr(run_volume_calc, "run_volume_calc", lambda args: expected)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                str(tmp_path),
                "--domain-type",
                "material",
                "--domain-ids",
                "1,2",
                "--samples",
                "1000",
                "--trigger-type",
                "std_dev",
                "--trigger-threshold",
                "0.01",
            ],
        )
        run_volume_calc.main()
        out_lines = capsys.readouterr().out.strip().splitlines()
        assert len(out_lines) == 1
        assert json.loads(out_lines[0]) == expected

    def test_exception_returns_json_error(self, monkeypatch, capsys, tmp_path):
        """An exception in the run function yields success=false with traceback."""

        def boom(args):
            raise RuntimeError("kaboom")

        monkeypatch.setattr(run_volume_calc, "run_volume_calc", boom)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "run_volume_calc.py",
                str(tmp_path),
                "--domain-type",
                "cell",
                "--domain-ids",
                "1",
                "--samples",
                "100",
            ],
        )
        with pytest.raises(SystemExit) as exc:
            run_volume_calc.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "kaboom" in result["error"]
        assert "traceback" in result


class TestOpenMCIntegration:
    def test_volume_calculation_api(self):
        """openmc.VolumeCalculation accepts the arguments the script passes."""
        openmc = pytest.importorskip("openmc")

        cell = openmc.Cell(1)
        vol = openmc.VolumeCalculation([cell], 100, [-1.0, -1.0, -1.0], [1.0, 1.0, 1.0])
        vol.set_trigger(0.01, "std_dev")
        assert vol.ids == [1]
        assert vol.domain_type == "cell"
