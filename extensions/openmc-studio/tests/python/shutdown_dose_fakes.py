"""Fake OpenMC objects for shutdown-dose driver unit tests.

The drivers accept injected OpenMC/D1S modules, so the tests can verify domain
resolution, schedule normalization, bounding boxes, parent-nuclide options, and
D1S corrections without importing the real OpenMC stack.
"""

from contextlib import nullcontext
from types import SimpleNamespace

import numpy as np


class FakeParticleFilter:
    """Minimal ParticleFilter with string bins."""

    def __init__(self, bins):
        self.bins = [bins] if isinstance(bins, str) else list(bins)


class FakeParentNuclideFilter:
    """Minimal ParentNuclideFilter."""

    def __init__(self, bins):
        self.bins = list(bins)


class FakeTally:
    """Tally stub with numpy mean/std_dev arrays."""

    def __init__(self, tally_id=7, name="photon flux", mean=None, filters=None, scores=None):
        self.id = tally_id
        self.name = name
        self.mean = np.asarray(mean if mean is not None else [1.0, 2.0, 3.0], dtype=float)
        self.std_dev = np.full(self.mean.shape, 0.1)
        self.filters = list(filters) if filters is not None else [FakeParticleFilter("photon")]
        self.scores = list(scores) if scores is not None else ["flux"]


class FakeCell:
    """Material-filled activation cell with a computed bounding box."""

    def __init__(self, cell_id=1, volume=1.0):
        self.id = cell_id
        self.volume = volume
        self.fill = SimpleNamespace(get_nuclides=lambda: ["Fe56"])
        self.bounding_box = FakeBoundingBox((-1.0, -1.0, -1.0), (1.0, 1.0, 1.0))


class FakeBoundingBox:
    """Bounding box with OpenMC's lower_left/upper_right attributes."""

    def __init__(self, lower_left, upper_right):
        self.lower_left = tuple(lower_left)
        self.upper_right = tuple(upper_right)


class FakeGeometry:
    """Geometry stub exposing get_all_cells()."""

    def __init__(self, cells):
        self._cells = {cell.id: cell for cell in cells}

    def get_all_cells(self):
        return dict(self._cells)


class FakeTallies(list):
    """List-like Tallies collection."""


class FakeModel:
    """Model stub used by the drivers."""

    def __init__(
        self, geometry=None, materials=None, settings=None, tallies=None, plots=None, **kwargs
    ):
        self.geometry = geometry or FakeGeometry([FakeCell()])
        self.materials = materials
        self.settings = settings or SimpleNamespace(photon_transport=None, use_decay_photons=None)
        self.tallies = tallies if tallies is not None else FakeTallies([FakeTally()])
        self.plots = plots

    @classmethod
    def from_xml(cls, *args, **kwargs):
        cells = kwargs.pop("cells", None) or [FakeCell()]
        tallies = kwargs.pop("tallies", None) or [FakeTally()]
        return cls(geometry=FakeGeometry(cells), tallies=FakeTallies(tallies))


class FakeConfig:
    """Config mapping with a no-op patch context manager."""

    def patch(self, key, value):
        return nullcontext()


class FakeRegularMesh:
    """Regular mesh stub with overlap-relevant bounds."""

    def __init__(self, mesh_id=3, lower_left=(0, 0, 0), upper_right=(1, 1, 1)):
        self.id = mesh_id
        self.lower_left = tuple(lower_left)
        self.upper_right = tuple(upper_right)

    @classmethod
    def from_xml_element(cls, element):
        return cls(mesh_id=int(element.get("id") or 1))


class FakeCylindricalMesh(FakeRegularMesh):
    """Cylindrical mesh stub."""


class FakeSphericalMesh(FakeRegularMesh):
    """Spherical mesh stub."""


class FakeStatePoint:
    """StatePoint context manager returning selected tallies."""

    def __init__(self, path, tallies=None):
        self.path = path
        self.tallies = tallies or {}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeR2SManager:
    """R2SManager stub recording every step call."""

    instances = []

    def __init__(self, neutron_model, domains, photon_model=None):
        self.neutron_model = neutron_model
        self.domains = domains
        self.photon_model = photon_model
        self.results = {}
        self.step1_args = None
        self.step2_args = None
        self.step3_args = None
        self.step4_args = None
        FakeR2SManager.instances.append(self)

    def step1_neutron_transport(self, output_dir, mat_vol_kwargs=None, micro_kwargs=None):
        self.step1_args = (output_dir, mat_vol_kwargs, micro_kwargs)

    def step2_activation(
        self, timesteps, source_rates, timestep_units="s", output_dir=None, **kwargs
    ):
        self.step2_args = (timesteps, source_rates, timestep_units, output_dir)
        self.results["activation_materials"] = [
            SimpleNamespace(id=101, name="Activation cell", volume=1.0)
        ]
        self.results["depletion_results"] = None

    def step3_photon_source(
        self, time_indices=None, bounding_boxes=None, output_dir=None, **kwargs
    ):
        self.step3_args = (time_indices, bounding_boxes, output_dir)

    def step4_photon_transport(self, output_dir, run_kwargs=None, by_parent_nuclide=False):
        self.step4_args = (output_dir, run_kwargs, by_parent_nuclide)
        self.results["photon_tallies"] = {1: [FakeTally()]}


class FakeD1S:
    """D1S module stub."""

    def __init__(self, nuclides=None):
        self.nuclides = nuclides or ["Co60"]
        self.prepare_args = None
        self.correction_args = None
        self.factors = {name: np.array([0.0, 2.0]) for name in self.nuclides}

    def get_radionuclides(self, model, chain_file=None):
        return list(self.nuclides)

    def prepare_tallies(self, model, nuclides=None, chain_file=None):
        self.prepare_args = (nuclides, chain_file)
        return list(self.nuclides)

    def time_correction_factors(self, nuclides, timesteps, source_rates, timestep_units="s"):
        return {name: self.factors[name] for name in nuclides}

    def apply_time_correction(self, tally, factors, index=-1, sum_nuclides=True):
        self.correction_args = (tally.id, index, sum_nuclides)
        corrected = FakeTally(tally_id=tally.id, name="corrected", mean=tally.mean * 2.0)
        if not sum_nuclides:
            corrected.filters.append(FakeParentNuclideFilter(self.nuclides))
        return corrected


def make_openmc_module(d1s=None, tallies=None, cells=None):
    """Build a fake OpenMC module with the attributes the drivers use."""
    fake_d1s = d1s

    module = SimpleNamespace(
        ParticleFilter=FakeParticleFilter,
        ParentNuclideFilter=FakeParentNuclideFilter,
        Tallies=FakeTallies,
        BoundingBox=FakeBoundingBox,
        RegularMesh=FakeRegularMesh,
        CylindricalMesh=FakeCylindricalMesh,
        SphericalMesh=FakeSphericalMesh,
        StatePoint=FakeStatePoint,
        config=FakeConfig(),
        deplete=SimpleNamespace(R2SManager=FakeR2SManager),
    )
    module.Model = type(
        "BoundFakeModel",
        (FakeModel,),
        {
            "from_xml": classmethod(
                lambda cls, *args, **kwargs: FakeModel.from_xml(cells=cells, tallies=tallies)
            )
        },
    )
    if fake_d1s is not None:
        module.d1s = fake_d1s
    return module
