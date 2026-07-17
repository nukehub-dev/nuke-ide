"""Tests for plugins.base.lib.dagmc and plugins.base.lib.step helpers.

Both modules are stdlib-only at import time (heavy deps are imported
lazily inside functions), so they are safe to import everywhere.
"""

import os

import pytest

from plugins.base.lib import dagmc as dagmc_lib
from plugins.base.lib import step as step_lib


@pytest.fixture
def h5m_file(tmp_path):
    f = tmp_path / 'model.h5m'
    f.write_bytes(b'fake h5m content')
    return f


@pytest.fixture
def step_file(tmp_path):
    f = tmp_path / 'bracket.step'
    f.write_bytes(b'ISO-10303-21 fake step content')
    return f


def test_dagmc_cache_path_deterministic(h5m_file, tmp_path):
    """Same inputs produce the same cache path on repeated calls."""
    cache_dir = str(tmp_path / 'cache')
    path1, exists1 = dagmc_lib.get_cache_path(str(h5m_file), cache_dir)
    path2, exists2 = dagmc_lib.get_cache_path(str(h5m_file), cache_dir)

    assert path1 == path2
    assert exists1 is False
    assert exists2 is False
    # Cache directory was created as a side effect.
    assert os.path.isdir(cache_dir)


def test_dagmc_cache_path_naming_scheme(h5m_file, tmp_path):
    """The cache filename embeds the stem, a 12-char hash and a suffix."""
    path, _ = dagmc_lib.get_cache_path(str(h5m_file), str(tmp_path / 'cache'))
    name = os.path.basename(path)

    stem, suffix = name.rsplit('_', 1)
    assert suffix == 'raw.vtk'
    file_stem, file_hash = stem.rsplit('_', 1)
    assert file_stem == 'model'
    assert len(file_hash) == 12


def test_dagmc_cache_path_filtered_flag_changes_path(h5m_file, tmp_path):
    """Filtered and unfiltered variants get distinct cache files."""
    raw, _ = dagmc_lib.get_cache_path(str(h5m_file), str(tmp_path / 'cache'), filtered=False)
    filt, _ = dagmc_lib.get_cache_path(str(h5m_file), str(tmp_path / 'cache'), filtered=True)

    assert raw != filt
    assert raw.endswith('_raw.vtk')
    assert filt.endswith('_filtered.vtk')


def test_dagmc_cache_path_differs_for_different_files(h5m_file, tmp_path):
    """A different input file hashes to a different cache path."""
    other = tmp_path / 'other.h5m'
    other.write_bytes(b'fake h5m content')  # same content, different name

    path1, _ = dagmc_lib.get_cache_path(str(h5m_file), str(tmp_path / 'cache'))
    path2, _ = dagmc_lib.get_cache_path(str(other), str(tmp_path / 'cache'))

    assert path1 != path2


def test_dagmc_cache_path_exists_flag(h5m_file, tmp_path):
    """The exists flag flips to True once the cache file is present."""
    cache_dir = str(tmp_path / 'cache')
    path, exists = dagmc_lib.get_cache_path(str(h5m_file), cache_dir)
    assert exists is False

    with open(path, 'w') as fh:
        fh.write('cached vtk')

    _, exists = dagmc_lib.get_cache_path(str(h5m_file), cache_dir)
    assert exists is True


def test_step_cache_path_deterministic_and_sensitive_to_content(step_file, tmp_path):
    """STEP cache paths are stable for unchanged files and change when
    the file content (and thus its size) changes."""
    cache_dir = str(tmp_path / 'cache')

    path1, _ = step_lib.get_cache_path(str(step_file), cache_dir)
    path2, _ = step_lib.get_cache_path(str(step_file), cache_dir)
    assert path1 == path2

    step_file.write_bytes(b'ISO-10303-21 fake step content, now longer')
    path3, _ = step_lib.get_cache_path(str(step_file), cache_dir)
    assert path3 != path1

    # STEP cache files use the plain .vtk suffix without a filter tag.
    assert os.path.basename(path1).startswith('bracket_')
    assert path1.endswith('.vtk')


def test_compute_triangle_area_known_triangles():
    """_compute_triangle_area matches analytic results for known triangles."""
    pytest.importorskip('numpy')  # lazy import inside the function

    # Right triangle with legs 1 and 1 -> area 0.5
    assert dagmc_lib._compute_triangle_area(
        (0, 0, 0), (1, 0, 0), (0, 1, 0)
    ) == pytest.approx(0.5)

    # 3-4-5 right triangle -> area 6
    assert dagmc_lib._compute_triangle_area(
        (0, 0, 0), (3, 0, 0), (0, 4, 0)
    ) == pytest.approx(6.0)

    # Non-axis-aligned triangle in 3D: vertices of an equilateral triangle
    # with side sqrt(2) on the coordinate planes -> area sqrt(3)/2
    assert dagmc_lib._compute_triangle_area(
        (1, 0, 0), (0, 1, 0), (0, 0, 1)
    ) == pytest.approx(3 ** 0.5 / 2)


def test_compute_triangle_area_degenerate():
    """Collinear points produce zero area."""
    pytest.importorskip('numpy')

    assert dagmc_lib._compute_triangle_area(
        (0, 0, 0), (1, 1, 1), (2, 2, 2)
    ) == pytest.approx(0.0)
