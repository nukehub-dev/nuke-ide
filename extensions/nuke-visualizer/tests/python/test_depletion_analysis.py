"""Tests for plugins.openmc.lib.depletion_analysis.

The helpers are exercised with fake StepResult/Material objects so the
pytest+numpy profile covers contact-dose and decay-spectrum shaping without
OpenMC installed.
"""

import pytest
from plugins.openmc.lib import depletion_analysis


class FakeDiscrete:
    """Minimal openmc.stats.Discrete stand-in."""

    def __init__(self, x, p):
        self.x = list(x)
        self.p = list(p)

    def integral(self):
        return sum(self.p)


class FakeTabular:
    """Minimal openmc.stats.Tabular stand-in (continuous component)."""

    interpolation = "linear-linear"

    def __init__(self, x, p):
        self.x = list(x)
        self.p = list(p)

    def integral(self):
        return sum(
            (a + b) * (x1 - x0) / 2
            for a, b, x0, x1 in zip(self.p, self.p[1:], self.x, self.x[1:], strict=False)
        )


class FakeMixture:
    """Minimal openmc.stats.Mixture stand-in."""

    def __init__(self, probability, distribution):
        self.probability = list(probability)
        self.distribution = list(distribution)

    def integral(self):
        return sum(
            p * d.integral() for p, d in zip(self.probability, self.distribution, strict=False)
        )


class FakeMaterial:
    def __init__(self, name, volume, doses, activity, spectrum):
        self.name = name
        self.volume = volume
        self._doses = doses
        self._activity = activity
        self._spectrum = spectrum

    def get_photon_contact_dose_rate(self, dose_quantity, build_up, by_nuclide):
        assert by_nuclide is True
        assert build_up > 0
        return dict(self._doses[dose_quantity])

    def get_activity(self, units):
        assert units == "Bq"
        return self._activity

    def get_decay_photon_energy(self, units, volume):
        assert units == "Bq"
        return self._spectrum


class FakeStep:
    def __init__(self, time, material):
        self.time = time
        self._material = material

    def get_material(self, material_id):
        assert material_id == "4"
        return self._material


def test_contact_dose_totals_and_by_nuclide():
    results = [
        FakeStep(
            [0.0, 86400.0],
            FakeMaterial("Cell 1", 0.5, {"absorbed-air": {"I135": 1.0, "O16": 0.0}}, 1.0, None),
        ),
        FakeStep(
            [86400.0, 172800.0],
            FakeMaterial("Cell 1", 0.5, {"absorbed-air": {"I135": 2.0, "O16": 0.0}}, 2.0, None),
        ),
    ]

    payload = depletion_analysis.summarize_contact_dose(
        results, 4, dose_quantity="absorbed-air", build_up=2.0, by_nuclide=True
    )

    assert payload["unit"] == "Gy/h"
    assert payload["timeDays"] == pytest.approx([0.0, 1.0])
    assert payload["total"] == pytest.approx([1.0, 2.0])
    assert payload["contributingNuclides"] == 1
    assert payload["byNuclide"] == [{"nuclide": "I135", "values": [1.0, 2.0]}]
    assert "slab" in payload["caveat"]


def test_contact_dose_by_nuclide_stays_aligned_when_a_key_appears_later():
    results = [
        FakeStep(
            [0.0, 86400.0], FakeMaterial("Cell 1", 0.5, {"absorbed-air": {"O16": 0.0}}, 1.0, None)
        ),
        FakeStep(
            [86400.0, 172800.0],
            FakeMaterial("Cell 1", 0.5, {"absorbed-air": {"I135": 3.0}}, 2.0, None),
        ),
    ]
    payload = depletion_analysis.summarize_contact_dose(results, 4, by_nuclide=True)
    assert payload["byNuclide"] == [{"nuclide": "I135", "values": [0.0, 3.0]}]
    assert payload["total"] == pytest.approx([0.0, 3.0])


def test_contact_dose_empty_state_for_stable_material():
    results = [
        FakeStep(
            [0.0, 86400.0], FakeMaterial("Cell 1", 0.5, {"effective": {"O16": 0.0}}, 0.0, None)
        ),
    ]
    payload = depletion_analysis.summarize_contact_dose(results, 4, dose_quantity="effective")
    assert payload["unit"] == "Sv/h"
    assert payload["contributingNuclides"] == 0
    assert "No unstable nuclides" in payload["emptyReason"]
    assert "byNuclide" not in payload


def test_contact_dose_rejects_bad_inputs():
    results = []
    with pytest.raises(ValueError):
        depletion_analysis.summarize_contact_dose(results, 4, dose_quantity="kerma")
    with pytest.raises(ValueError):
        depletion_analysis.summarize_contact_dose(results, 4, build_up=0)


def test_decay_spectrum_discrete_and_total_activity():
    spectrum = FakeDiscrete([1.0e5, 2.0e5], [5.0, 3.0])
    results = [FakeStep([0.0, 86400.0], FakeMaterial("Cell 1", 0.5, {}, 42.0, spectrum))]
    payload = depletion_analysis.summarize_decay_spectrum(results, 4, 0)

    assert payload["kind"] == "discrete"
    assert payload["totalActivityBq"] == pytest.approx(42.0)
    assert payload["totalPhotonIntensityBq"] == pytest.approx(8.0)
    assert [line["energyEv"] for line in payload["lines"]] == [1.0e5, 2.0e5]
    assert payload["curves"] == []
    assert "emptyReason" not in payload


def test_decay_spectrum_mixture_flattens_weighted_components():
    discrete = FakeDiscrete([1.0e5], [10.0])
    tabular = FakeTabular([2.0e5, 3.0e5], [4.0, 2.0])
    spectrum = FakeMixture([0.25, 0.75], [tabular, discrete])
    results = [FakeStep([0.0, 86400.0], FakeMaterial("Cell 1", 0.5, {}, 10.0, spectrum))]
    payload = depletion_analysis.summarize_decay_spectrum(results, 4, 0)

    assert payload["kind"] == "mixture"
    assert payload["lines"] == [{"energyEv": 1.0e5, "intensity": 7.5}]
    assert payload["curves"][0]["intensityPerEv"] == pytest.approx([1.0, 0.5])
    assert payload["totalPhotonIntensityBq"] == pytest.approx(0.25 * 300000.0 + 0.75 * 10.0)


def test_decay_spectrum_empty_and_index_errors():
    results = [FakeStep([0.0, 0.0], FakeMaterial("Cell 1", 0.5, {}, 0.0, None))]
    payload = depletion_analysis.summarize_decay_spectrum(results, 4, 0)
    assert payload["lines"] == []
    assert payload["curves"] == []
    assert "No decay-photon lines" in payload["emptyReason"]
    with pytest.raises(IndexError):
        depletion_analysis.summarize_decay_spectrum(results, 4, 3)


def test_decimate_series_keeps_endpoints_and_limit():
    x, y = depletion_analysis.decimate_series(list(range(100)), list(range(100)), max_points=10)
    assert len(x) == 10
    assert x[0] == 0 and x[-1] == 99
    assert y[0] == 0 and y[-1] == 99
