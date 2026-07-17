"""Tests for dagmc_info: error shapes for missing pydagmc and missing files.

No real .h5m files or pydagmc models are used; pydagmc is either blocked
(None in sys.modules -> ImportError) or replaced with a bare stub module so
the file-existence check is reached deterministically in any environment.
"""

import json
import sys
import types

import pytest

import dagmc_info


class TestGetDagmcInfo:
    def test_missing_pydagmc_dependency(self, monkeypatch):
        """Without pydagmc, the documented install-hint error is returned."""
        monkeypatch.setitem(sys.modules, 'pydagmc', None)
        result = dagmc_info.get_dagmc_info('whatever.h5m')
        assert result == {
            'success': False,
            'error': 'pydagmc not available. Install with: pip install pydagmc',
        }

    def test_nonexistent_file(self, monkeypatch, tmp_path):
        """With pydagmc importable, a missing file yields 'File not found'."""
        fake_pydagmc = types.ModuleType('pydagmc')
        monkeypatch.setitem(sys.modules, 'pydagmc', fake_pydagmc)
        missing = tmp_path / 'nope.h5m'
        result = dagmc_info.get_dagmc_info(str(missing))
        assert result == {'success': False, 'error': f'File not found: {missing}'}


class TestMain:
    def test_json_output_on_error_prints_json_and_returns(self, monkeypatch, capsys, tmp_path):
        """--output-json prints the error dict as JSON without sys.exit."""
        monkeypatch.setitem(sys.modules, 'pydagmc', types.ModuleType('pydagmc'))
        missing = str(tmp_path / 'nope.h5m')
        monkeypatch.setattr(sys, 'argv', ['dagmc_info.py', missing, '--output-json'])
        assert dagmc_info.main() is None
        out = json.loads(capsys.readouterr().out)
        assert out['success'] is False
        assert 'error' in out

    def test_pretty_output_on_error_exits_1(self, monkeypatch, capsys, tmp_path):
        """The human-readable error path prints 'Error:' and exits 1."""
        monkeypatch.setitem(sys.modules, 'pydagmc', types.ModuleType('pydagmc'))
        missing = str(tmp_path / 'nope.h5m')
        monkeypatch.setattr(sys, 'argv', ['dagmc_info.py', missing])
        with pytest.raises(SystemExit) as exc:
            dagmc_info.main()
        assert exc.value.code == 1
        assert 'Error:' in capsys.readouterr().out

    def test_help_exits_with_code_0(self, monkeypatch):
        """--help prints usage and exits 0."""
        monkeypatch.setattr(sys, 'argv', ['dagmc_info.py', '--help'])
        with pytest.raises(SystemExit) as exc:
            dagmc_info.main()
        assert exc.value.code == 0
