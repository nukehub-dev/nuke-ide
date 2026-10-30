#!/usr/bin/env python3
# *****************************************************************************
# Copyright (C) 2024 NukeHub and others.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
# SPDX-License-Identifier: BSD-2-Clause
# *****************************************************************************
"""Versioned built-in isotropic material property cards for nuke-cad.

Pure data plus lookup helpers; stdlib only, so this module stays importable
in the minimal pytest profile (pytest + numpy only). Mirrors the
versioned-table pattern of ``fastener_data.py``.

Each card carries the isotropic mechanical/thermal payload the pipeline
consumes behind a body-level material *name* (the name tag itself lives on
``BodyDef.material`` and travels through the region manifest; this module
only holds the property payload):

- ``E`` — Young's modulus, Pa
- ``nu`` — Poisson's ratio, dimensionless
- ``rho`` — mass density, kg/m^3
- ``k`` — thermal conductivity, W/(m*K)
- ``cp`` — specific heat, J/(kg*K); stored for future coupled-physics
  (Cardinal) coupling, reserved for coupled-physics
- ``alpha`` — linear thermal expansion coefficient, 1/K
- ``yield`` — yield strength, Pa; optional. The FEM service derives a
  per-node safety-factor result (``yield / mises``) only for materials
  whose card carries this field; cards without it simply omit the safety
  factor for their blocks (reported in the run warnings, never defaulted).

Cards are keyed by the same names ``fem_service._builtin_materials`` knows
(``structural_steel``, ``aluminum``, ``copper``, ``uo2``, ``zircaloy``,
``concrete``); values are nominal room-temperature reference values.

Bump :data:`MATERIAL_DATA_VERSION` whenever a card is added, removed, or
corrected so consumers can gate on it.
"""

from __future__ import annotations

from typing import Any

#: Version of the cards below. Bump on any entry add/remove/correction or
#: supported-field change (``yield`` arrived in version 2).
MATERIAL_DATA_VERSION = 2

#: Card field ids, in documented order.
MATERIAL_FIELDS: tuple[str, ...] = ("E", "nu", "rho", "k", "cp", "alpha", "yield")

#: Documented units per field. ``nu`` is dimensionless.
MATERIAL_UNITS: dict[str, str] = {
    "E": "Pa",
    "nu": "dimensionless",
    "rho": "kg/m^3",
    "k": "W/(m*K)",
    "cp": "J/(kg*K)",
    "alpha": "1/K",
    "yield": "Pa",
}

#: Built-in isotropic cards keyed by material name. Values are nominal
#: room-temperature reference values (mechanical values match the historic
#: ``fem_service`` built-ins exactly; ``cp`` is a handbook reference).
#: No built-in card carries ``yield``: grade- and temper-dependent strengths
#: are never defaulted. Custom cards add ``yield`` to enable the FEM
#: safety-factor result for their blocks.
BUILTIN_MATERIAL_CARDS: dict[str, dict[str, float]] = {
    "structural_steel": {
        "E": 210e9,
        "nu": 0.3,
        "rho": 7850.0,
        "k": 50.0,
        "cp": 470.0,
        "alpha": 12e-6,
    },
    "aluminum": {
        "E": 70e9,
        "nu": 0.33,
        "rho": 2700.0,
        "k": 205.0,
        "cp": 900.0,
        "alpha": 23e-6,
    },
    "copper": {
        "E": 110e9,
        "nu": 0.34,
        "rho": 8960.0,
        "k": 400.0,
        "cp": 385.0,
        "alpha": 17e-6,
    },
    "uo2": {
        "E": 220e9,
        "nu": 0.316,
        "rho": 10960.0,
        "k": 3.5,
        "cp": 235.0,
        "alpha": 10e-6,
    },
    "zircaloy": {
        "E": 99e9,
        "nu": 0.37,
        "rho": 6550.0,
        "k": 13.0,
        "cp": 330.0,
        "alpha": 6e-6,
    },
    "concrete": {
        "E": 30e9,
        "nu": 0.2,
        "rho": 2400.0,
        "k": 1.5,
        "cp": 880.0,
        "alpha": 10e-6,
    },
}


def builtin_material_names() -> list[str]:
    """Return the built-in card names, in table order."""
    return list(BUILTIN_MATERIAL_CARDS)


def builtin_card(name: str) -> dict[str, float]:
    """Return a copy of the built-in card for ``name``.

    Raises :exc:`KeyError` for unknown names. The result is a copy so
    callers cannot mutate the versioned table.
    """
    try:
        card = BUILTIN_MATERIAL_CARDS[name]
    except KeyError:
        raise KeyError(f"unknown material card: {name!r}") from None
    return dict(card)


def validate_card(card: Any, *, label: str = "card") -> dict[str, float]:
    """Validate a material card mapping and return it as a plain dict.

    Every present field must be one of :data:`MATERIAL_FIELDS` with a
    numeric (int/float) value; unknown fields raise :exc:`ValueError` so
    typos (e.g. ``youngsModulus``) fail loudly instead of silently
    dropping a property. Fields are all optional so a custom card may
    override a subset; consumers treat missing fields as absent.
    """
    if not isinstance(card, dict):
        raise ValueError(f"{label} must be an object")
    validated: dict[str, float] = {}
    for field, value in card.items():
        if field not in MATERIAL_FIELDS:
            raise ValueError(
                f"{label} has unknown field {field!r}; expected one of {list(MATERIAL_FIELDS)}"
            )
        if not isinstance(value, (int, float)):
            raise ValueError(f"{label}.{field} must be a number")
        validated[field] = float(value)
    return validated
