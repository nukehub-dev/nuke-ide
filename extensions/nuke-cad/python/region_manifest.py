"""Region manifest parser and validator for nuke-cad.

The manifest is a JSON sidecar beside the model script:

    model.py                 # source of truth
    model.regions.json       # named volumes/surfaces and materials

Schema (version 1):

    {
      "version": 1,
      "volumes": [
        {"selector": "fuel_pin", "name": "fuel", "material": "UO2", "tags": ["depletable"]}
      ],
      "surfaces": [
        {"selector": "clad.outer", "name": "clad_outer", "role": "boundary"}
      ]
    }

Selectors are stable script-side identifiers (build123d labels, CadQuery
names). The geometry service maps selectors to solid/face indices at build
time; this module only validates structural correctness.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CURRENT_VERSION = 1


class ManifestValidationError(ValueError):
    """Raised when a region manifest fails schema validation."""


class RegionManifest:
    """In-memory representation of a region manifest."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data
        self.volumes: list[dict[str, Any]] = list(data.get("volumes", []))
        self.surfaces: list[dict[str, Any]] = list(data.get("surfaces", []))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RegionManifest:
        """Validate ``data`` and return a ``RegionManifest`` instance."""
        _validate(data)
        return cls(data)

    @classmethod
    def from_file(cls, path: Path | str) -> RegionManifest:
        """Load and validate a manifest from disk."""
        path = Path(path)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ManifestValidationError(f"Invalid JSON in {path}: {exc}") from exc
        except OSError as exc:
            raise ManifestValidationError(f"Cannot read manifest {path}: {exc}") from exc

        _validate(data)
        return cls(data)

    def to_dict(self) -> dict[str, Any]:
        """Return the normalized manifest dictionary."""
        return {
            "version": CURRENT_VERSION,
            "volumes": self.volumes,
            "surfaces": self.surfaces,
        }

    def volume_names(self) -> set[str]:
        """Return the set of declared volume names."""
        return {v.get("name", "") for v in self.volumes if v.get("name")}

    def surface_names(self) -> set[str]:
        """Return the set of declared surface names."""
        return {s.get("name", "") for s in self.surfaces if s.get("name")}

    def duplicate_names(self) -> list[str]:
        """Return names that appear more than once across volumes or surfaces."""
        seen: set[str] = set()
        duplicates: set[str] = set()
        for name in (*self.volume_names(), *self.surface_names()):
            if name in seen:
                duplicates.add(name)
            seen.add(name)
        return sorted(duplicates)

    def unknown_selectors(self, known: set[str]) -> list[str]:
        """Return selectors referenced by the manifest that are not in ``known``."""
        referenced = {entry.get("selector", "") for entry in (*self.volumes, *self.surfaces)}
        return sorted(s for s in referenced if s and s not in known)

    def missing_material_volumes(self) -> list[str]:
        """Return volume selectors whose entries lack a material assignment."""
        return [v.get("selector", "") for v in self.volumes if not v.get("material")]


def _validate(data: Any) -> None:
    """Validate the top-level manifest schema."""
    if not isinstance(data, dict):
        raise ManifestValidationError("Manifest must be a JSON object")

    version = data.get("version")
    if version != CURRENT_VERSION:
        raise ManifestValidationError(
            f"Unsupported manifest version {version!r}; expected {CURRENT_VERSION}"
        )

    for key in ("volumes", "surfaces"):
        value = data.get(key)
        if value is None:
            continue
        if not isinstance(value, list):
            raise ManifestValidationError(f"'{key}' must be a list")
        for idx, entry in enumerate(value):
            _validate_entry(key, idx, entry)


def _validate_entry(kind: str, index: int, entry: Any) -> None:
    """Validate a single volume or surface entry."""
    if not isinstance(entry, dict):
        raise ManifestValidationError(f"{kind}[{index}] must be an object")

    selector = entry.get("selector")
    if not selector or not isinstance(selector, str):
        raise ManifestValidationError(f"{kind}[{index}] missing required 'selector' string")

    name = entry.get("name")
    if name is not None and not isinstance(name, str):
        raise ManifestValidationError(f"{kind}[{index}].name must be a string")

    if kind == "volumes":
        material = entry.get("material")
        if material is not None and not isinstance(material, str):
            raise ManifestValidationError(f"volumes[{index}].material must be a string")
        tags = entry.get("tags")
        if tags is not None and not isinstance(tags, list):
            raise ManifestValidationError(f"volumes[{index}].tags must be a list")
    elif kind == "surfaces":
        role = entry.get("role")
        if role is not None and not isinstance(role, str):
            raise ManifestValidationError(f"surfaces[{index}].role must be a string")
