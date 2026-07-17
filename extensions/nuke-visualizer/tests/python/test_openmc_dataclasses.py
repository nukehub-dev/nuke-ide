"""Tests for dataclasses in plugins.openmc.lib.overlap and openmc_vtk.

Both modules import numpy at their top level, so the whole test module
is skipped when numpy is unavailable. openmc itself is optional in
openmc_vtk (guarded import), so these tests run without it.
"""

from dataclasses import asdict

import pytest

np = pytest.importorskip('numpy')

from plugins.openmc.lib.overlap import (  # noqa: E402
    BoundingBox,
    OverlapProgress,
    OverlapResult,
)
from plugins.openmc.lib.openmc_vtk import (  # noqa: E402
    CellTallyData,
    MeshTallyData,
    TallyInfo,
)


def test_overlap_result_to_dict():
    """to_dict renames keys to camelCase and counts the cells."""
    overlap = OverlapResult(
        coordinates=(1.0, 2.0, 3.0),
        cell_ids=[10, 20],
        cell_names=['fuel', 'clad'],
    )
    assert overlap.to_dict() == {
        'coordinates': [1.0, 2.0, 3.0],
        'cellIds': [10, 20],
        'cellNames': ['fuel', 'clad'],
        'overlapCount': 2,
    }


def test_overlap_result_asdict_roundtrip():
    """asdict output feeds back into the constructor unchanged."""
    overlap = OverlapResult(
        coordinates=(0.5, -1.5, 2.5),
        cell_ids=[1, 2, 3],
        cell_names=['a', 'b', 'c'],
    )
    clone = OverlapResult(**asdict(overlap))
    assert clone == overlap
    assert asdict(clone) == asdict(overlap)


def test_overlap_progress_to_dict_nests_overlaps():
    """Nested OverlapResult entries are serialized inside progress."""
    overlap = OverlapResult(coordinates=(0.0, 0.0, 0.0), cell_ids=[1, 2], cell_names=[])
    progress = OverlapProgress(
        checked=50,
        total=100,
        percentage=50.0,
        current_overlaps=[overlap],
        complete=False,
    )
    data = progress.to_dict()

    assert data['checked'] == 50
    assert data['total'] == 100
    assert data['percentage'] == 50.0
    assert data['complete'] is False
    assert data['error'] is None
    assert data['currentOverlaps'] == [overlap.to_dict()]


def test_bounding_box_dict_roundtrip():
    """BoundingBox survives a to_dict/from_dict roundtrip."""
    box = BoundingBox(min=(-1.0, -2.0, -3.0), max=(4.0, 5.0, 6.0))

    data = box.to_dict()
    assert data == {'min': [-1.0, -2.0, -3.0], 'max': [4.0, 5.0, 6.0]}

    restored = BoundingBox.from_dict(data)
    assert restored == box
    assert restored.min == (-1.0, -2.0, -3.0)
    assert isinstance(restored.min, tuple)


def test_tally_info_asdict_roundtrip():
    """TallyInfo fields survive asdict and reconstruction."""
    info = TallyInfo(
        id=4,
        name='mesh tally',
        scores=['flux', 'heating'],
        nuclides=['total'],
        filters=[{'type': 'mesh', 'id': 1}],
        has_mesh=True,
        mesh_type='regular',
        mesh_dimensions=(10, 10, 10),
        mesh_bounds={'x': (-5.0, 5.0), 'y': (-5.0, 5.0), 'z': (0.0, 10.0)},
    )

    data = asdict(info)
    assert data['id'] == 4
    assert data['scores'] == ['flux', 'heating']
    assert data['has_mesh'] is True
    assert data['mesh_dimensions'] == (10, 10, 10)
    assert data['mesh_bounds']['z'] == (0.0, 10.0)

    assert TallyInfo(**data) == info


def test_tally_info_optional_mesh_fields_default():
    """Mesh-related fields default to empty/None for non-mesh tallies."""
    info = TallyInfo(id=1, name='cell tally', scores=['flux'], nuclides=[], filters=[])
    assert info.has_mesh is False
    assert info.mesh_type is None
    assert info.mesh_dimensions is None
    assert info.mesh_bounds is None


def test_mesh_tally_data_asdict_roundtrip():
    """MeshTallyData carries export metadata with a default dataset list."""
    data = MeshTallyData(
        tally_id=2,
        tally_name='fine mesh',
        score='flux',
        nuclide='total',
        vtk_path='/tmp/out.vtk',
        mesh_type='regular',
        dimensions=(5, 5, 5),
        bounds={'x': (0.0, 1.0)},
        data_range=(0.0, 3.14),
    )

    assert data.datasets == []

    serialized = asdict(data)
    assert serialized['tally_id'] == 2
    assert serialized['vtk_path'] == '/tmp/out.vtk'
    assert serialized['data_range'] == (0.0, 3.14)
    assert serialized['datasets'] == []

    assert MeshTallyData(**serialized) == data


def test_cell_tally_data_asdict():
    """CellTallyData stores per-cell values and errors."""
    cell_data = CellTallyData(
        tally_id=7,
        tally_name='cell flux',
        score='flux',
        nuclide='U235',
        cell_values={1: 0.5, 2: 1.5},
        cell_errors={1: 0.01, 2: 0.02},
    )

    serialized = asdict(cell_data)
    assert serialized == {
        'tally_id': 7,
        'tally_name': 'cell flux',
        'score': 'flux',
        'nuclide': 'U235',
        'cell_values': {1: 0.5, 2: 1.5},
        'cell_errors': {1: 0.01, 2: 0.02},
    }
    assert CellTallyData(**serialized) == cell_data
