"""Tests for run_depletion: log_progress and main() argparse wiring.

The real depletion run (openmc) is never exercised here; main() is tested
with run_depletion.run_depletion replaced by a stub, and argparse error
paths raise SystemExit before any openmc import happens.
"""

import json
import sys

import pytest

import run_depletion


class TestLogProgress:
    def test_writes_message_to_stderr(self, capsys):
        """log_progress prints the bare message to stderr, not stdout."""
        run_depletion.log_progress('step 1')
        captured = capsys.readouterr()
        assert captured.err == 'step 1\n'
        assert captured.out == ''

    def test_writes_multiple_lines(self, capsys):
        """Each call appends one line to stderr."""
        run_depletion.log_progress('a')
        run_depletion.log_progress('b')
        assert capsys.readouterr().err == 'a\nb\n'


class TestMainArgparse:
    def test_no_arguments_exits_with_code_2(self, monkeypatch):
        """Missing working_directory and --time-steps is an argparse error."""
        monkeypatch.setattr(sys, 'argv', ['run_depletion.py'])
        with pytest.raises(SystemExit) as exc:
            run_depletion.main()
        assert exc.value.code == 2

    def test_missing_time_steps_exits_with_code_2(self, monkeypatch):
        """--time-steps is required."""
        monkeypatch.setattr(sys, 'argv', ['run_depletion.py', '/tmp/model'])
        with pytest.raises(SystemExit) as exc:
            run_depletion.main()
        assert exc.value.code == 2

    def test_invalid_solver_choice_exits_with_code_2(self, monkeypatch):
        """An unknown --solver value is rejected by argparse choices."""
        monkeypatch.setattr(sys, 'argv', [
            'run_depletion.py', '/tmp/model',
            '--time-steps', '1', '--solver', 'bogus',
        ])
        with pytest.raises(SystemExit) as exc:
            run_depletion.main()
        assert exc.value.code == 2

    def test_help_exits_with_code_0(self, monkeypatch):
        """--help prints usage and exits 0."""
        monkeypatch.setattr(sys, 'argv', ['run_depletion.py', '--help'])
        with pytest.raises(SystemExit) as exc:
            run_depletion.main()
        assert exc.value.code == 0


class TestMainDispatch:
    def test_success_path_prints_json_and_returns_0(self, monkeypatch, capsys):
        """A successful run prints the summary JSON to stdout and returns 0."""
        captured_args = {}

        def fake_run(args):
            captured_args.update(vars(args))
            return {'success': True, 'power': args.power}

        monkeypatch.setattr(run_depletion, 'run_depletion', fake_run)
        monkeypatch.setattr(sys, 'argv', [
            'run_depletion.py', '/tmp/model',
            '--time-steps', '86400,86400', '--power', '1e6',
        ])
        assert run_depletion.main() == 0
        out = json.loads(capsys.readouterr().out)
        assert out == {'success': True, 'power': 1e6}
        # Defaults wired by argparse.
        assert captured_args['solver'] == 'cecm'
        assert captured_args['operator'] == 'coupled'
        assert captured_args['normalization'] == 'fission-q'
        assert captured_args['substeps'] == 1
        assert captured_args['working_directory'] == '/tmp/model'
        assert captured_args['time_steps'] == '86400,86400'

    def test_failure_path_prints_error_json_and_returns_1(self, monkeypatch, capsys):
        """An exception in run_depletion yields an error JSON and return 1."""
        def fake_run(args):
            raise ValueError('no power specified')

        monkeypatch.setattr(run_depletion, 'run_depletion', fake_run)
        monkeypatch.setattr(sys, 'argv', [
            'run_depletion.py', '/tmp/model', '--time-steps', '1',
        ])
        assert run_depletion.main() == 1
        captured = capsys.readouterr()
        out = json.loads(captured.out)
        assert out == {'success': False, 'error': 'no power specified'}
        assert 'FAILED: no power specified' in captured.err
