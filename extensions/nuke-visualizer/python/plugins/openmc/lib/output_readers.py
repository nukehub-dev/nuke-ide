"""Shared readers for OpenMC HDF5 output files (particle tracks, collision
tracks, weight windows, IFP kinetics parameters).

All public functions return JSON-safe dicts and raise :class:`OutputReaderError`
with a human-readable message on any failure (missing dependency, missing file,
unexpected layout). Command wrappers in ``plugins.openmc.commands`` convert
these to the single-JSON-object-on-stdout contract.

File layouts verified against the OpenMC source tree:

- ``tracks.h5`` / ``tracks_p<N>.h5`` — top-level compound datasets named
  ``track_<batch>_<gen>_<particle_id>`` (TrackState fields: ``r``/``u``
  compound ``(x, y, z)`` doubles, ``E``, ``time``, ``wgt`` doubles,
  ``cell_id``, ``cell_instance``, ``material_id`` int32) with dataset
  attributes ``n_particles``, ``offsets`` (len n_particles + 1) and
  ``particles`` (PDG numbers). File attrs ``filetype="track"``,
  ``version=[3, 1]``. See openmc/tracks.py and src/track_output.cpp.
- ``collision_track.h5`` — single compound dataset ``collision_track_bank``
  (fields ``r``, ``u``, ``E``, ``dE``, ``time``, ``wgt`` doubles;
  ``event_mt``, ``delayed_group``, ``cell_id``, ``nuclide_id``,
  ``material_id``, ``universe_id``, ``n_collision``, ``particle`` int32;
  ``parent_id``, ``progeny_id`` int64). File attrs
  ``filetype="collision_track"``, ``version=[1, 2]``.
  See src/collision_track.cpp.
- ``weight_windows.h5`` — group ``weight_windows`` (attrs ``n_weight_windows``,
  ``ids``) with subgroups ``weight_windows_<id>`` holding datasets ``mesh``,
  ``particle_type``, ``energy_bounds``, ``lower_ww_bounds``,
  ``upper_ww_bounds`` (flat, C-order with shape ``(n_energy, nz, ny, nx)``),
  ``survival_ratio``, ``max_split``, ``weight_cutoff`` and optionally
  ``max_lower_bound_ratio``; group ``meshes`` with subgroups ``mesh <id>``
  (regular meshes: ``dimension``, ``lower_left``, ``upper_right``/``width``).
  See openmc/weight_windows.py and src/weight_windows.cpp.
- IFP kinetics — ``openmc.StatePoint.get_kinetics_parameters()`` computes
  beta_eff = ifp-beta-numerator / ifp-denominator and
  Lambda_eff = ifp-time-numerator / (ifp-denominator * k_eff) from statepoint
  tallies. The h5py fallback reproduces that math from the ``results``
  datasets (shape ``(n_filter_bins * n_nuclides, n_scores, 2)`` holding
  ``[sum, sum_sq]``; mean = sum / n_realizations,
  std = sqrt((sum_sq / n - mean**2) / (n - 1)). See openmc/statepoint.py
  and openmc/tallies.py.
"""

import glob
import math
import os
import re

try:
    import h5py

    HAS_H5PY = True
except ImportError:
    HAS_H5PY = False

import numpy as np

# PDG numbers used by OpenMC for the track 'particles' attribute
# (openmc/tracks.py stores ParticleType(pdg); src/particle.cpp maps the
# internal type enum to PDG numbers).
PARTICLE_PDG = {"neutron": 2112, "photon": 22, "electron": 11, "positron": -11}
_PDG_TO_NAME = {v: k for k, v in PARTICLE_PDG.items()}

DEFAULT_TRACK_LIMIT = 100
DEFAULT_MAX_POINTS_PER_TRACK = 1000
DEFAULT_COLLISION_LIMIT = 50000

_TRACK_DSET_RE = re.compile(r"^track_(\d+)_(\d+)_(\d+)$")


class OutputReaderError(Exception):
    """Raised when an output file cannot be read; message is user-facing."""


def _require_h5py():
    if not HAS_H5PY:
        raise OutputReaderError("h5py not installed")


def json_default(obj):
    """``json.dumps(default=...)`` hook for numpy/h5py scalar types."""
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8")
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def decimate_indices(n, max_points):
    """Indices into a sequence of length ``n`` with at most ``max_points`` entries.

    Evenly strided and always includes the first and last index so decimated
    polylines keep their endpoints. Returns every index when ``n`` fits or
    ``max_points`` is not a positive number.
    """
    if n <= 0:
        return np.zeros(0, dtype=int)
    if not max_points or max_points <= 0 or n <= max_points:
        return np.arange(n)
    # Pick a stride so the sample count (including both endpoints) stays
    # within max_points: count = ceil((n - 1) / stride) + 1 <= max_points.
    stride = math.ceil((n - 1) / (max_points - 1)) if max_points > 1 else n
    idx = np.arange(0, n - 1, stride)
    return np.append(idx, n - 1)


def resolve_output_files(path, patterns):
    """Resolve a file/directory/glob argument to a sorted list of HDF5 files.

    ``patterns`` is a tuple of fnmatch-style patterns (e.g. ``("tracks.h5",
    "tracks_p*.h5")``) used when ``path`` is a directory.
    """
    if os.path.isdir(path):
        files = []
        for pattern in patterns:
            files.extend(glob.glob(os.path.join(path, pattern)))
        files = sorted(set(files))
        if not files:
            raise OutputReaderError(f"No files matching {patterns} found in directory: {path}")
        return files
    if glob.has_magic(path):
        files = sorted(glob.glob(path))
        if not files:
            raise OutputReaderError(f"No files match glob: {path}")
        return files
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")
    return [path]


def _decode(value):
    """Decode h5py bytes/str scalars to str."""
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _particle_name(pdg):
    return _PDG_TO_NAME.get(int(pdg), f"pdg{int(pdg)}")


def particle_pdg(particle_filter):
    """Map a particle filter string ('neutron', 'photon', '2112', ...) to a PDG int."""
    if particle_filter is None:
        return None
    text = str(particle_filter).strip().lower()
    if text in PARTICLE_PDG:
        return PARTICLE_PDG[text]
    try:
        return int(text)
    except ValueError:
        raise OutputReaderError(
            f"Unknown particle filter: {particle_filter!r} "
            f"(expected one of {sorted(PARTICLE_PDG)} or a PDG number)"
        ) from None


# ---------------------------------------------------------------------------
# Particle tracks (tracks.h5 / tracks_p<N>.h5)
# ---------------------------------------------------------------------------


def _track_dset_key(name):
    """Parse 'track_<batch>_<gen>_<pid>' into a sortable (batch, gen, pid) tuple."""
    match = _TRACK_DSET_RE.match(name)
    if not match:
        return None
    return tuple(int(g) for g in match.groups())


def _iter_track_datasets(files):
    """Yield (path, dataset_name, (batch, gen, pid)) sorted by identifier."""
    entries = []
    for path in files:
        with h5py.File(path, "r") as f:
            for name in f.keys():
                key = _track_dset_key(name)
                if key is not None:
                    entries.append((path, name, key))
    entries.sort(key=lambda e: e[2])
    return entries


def read_tracks_info(path):
    """Summary of an OpenMC track file (or directory/glob of track files)."""
    _require_h5py()
    files = resolve_output_files(path, ("tracks.h5", "tracks_p*.h5"))

    tracks = []
    total_states = 0
    for file_path, name, key in _iter_track_datasets(files):
        batch, generation, particle_id = key
        with h5py.File(file_path, "r") as f:
            dset = f[name]
            offsets = dset.attrs.get("offsets")
            particles = dset.attrs.get("particles")
            n_states = int(dset.shape[0]) if dset.shape else 0
            segments = []
            if offsets is not None and particles is not None:
                offsets = [int(o) for o in offsets]
                for i, pdg in enumerate(particles):
                    segments.append(
                        {
                            "particle": _particle_name(pdg),
                            "pdg": int(pdg),
                            "nStates": offsets[i + 1] - offsets[i],
                        }
                    )
            total_states += n_states
            tracks.append(
                {
                    "file": file_path,
                    "dataset": name,
                    "batch": batch,
                    "generation": generation,
                    "particleId": particle_id,
                    "nStates": n_states,
                    "segments": segments,
                }
            )

    return {
        "files": files,
        "nTracks": len(tracks),
        "totalStates": total_states,
        "tracks": tracks,
    }


def _segment_to_json(states, pdg, n_states, stride):
    """Convert a (decimated) structured TrackState array slice to a JSON-safe dict.

    ``n_states`` is the segment's state count before decimation.
    """
    positions = np.column_stack([states["r"]["x"], states["r"]["y"], states["r"]["z"]])
    return {
        "particle": _particle_name(pdg),
        "pdg": int(pdg),
        "nStates": int(n_states),
        "stride": int(stride),
        "positions": positions.tolist(),
        "energies": states["E"].tolist(),
        "times": states["time"].tolist(),
        "weights": states["wgt"].tolist(),
        "cellIds": states["cell_id"].tolist(),
    }


def read_tracks_data(
    path,
    offset=0,
    limit=DEFAULT_TRACK_LIMIT,
    particle_filter=None,
    max_points_per_track=DEFAULT_MAX_POINTS_PER_TRACK,
    cell_filter=None,
    material_filter=None,
):
    """Read (decimated) particle track polylines from track file(s).

    ``offset``/``limit`` paginate over the flattened, identifier-sorted list of
    tracks across all resolved files; the limit is enforced server-side because
    these files get large. Each segment is decimated to at most
    ``max_points_per_track`` states (endpoints preserved).

    ``cell_filter``/``material_filter`` keep only segments that contain at
    least one state in the given cell/material IDs (matching openmc's
    ``Track.filter(state_filter=...)`` semantics).
    """
    _require_h5py()
    files = resolve_output_files(path, ("tracks.h5", "tracks_p*.h5"))
    pdg_filter = particle_pdg(particle_filter)

    entries = _iter_track_datasets(files)
    total_tracks = len(entries)
    if offset < 0:
        raise OutputReaderError(f"offset must be >= 0, got {offset}")
    if limit is not None and limit <= 0:
        raise OutputReaderError(f"limit must be > 0, got {limit}")
    selected = entries[offset : offset + limit if limit is not None else None]

    tracks = []
    for file_path, name, key in selected:
        batch, generation, particle_id = key
        with h5py.File(file_path, "r") as f:
            dset = f[name]
            states = dset[()]
            offsets = [int(o) for o in dset.attrs["offsets"]]
            particles = [int(p) for p in dset.attrs["particles"]]

        segments = []
        for i, pdg in enumerate(particles):
            if pdg_filter is not None and pdg != pdg_filter:
                continue
            segment_states = states[offsets[i] : offsets[i + 1]]
            if (
                cell_filter is not None
                and not np.isin(segment_states["cell_id"], list(cell_filter)).any()
            ):
                continue
            if (
                material_filter is not None
                and not np.isin(segment_states["material_id"], list(material_filter)).any()
            ):
                continue
            idx = decimate_indices(segment_states.shape[0], max_points_per_track)
            stride = int(idx[1] - idx[0]) if idx.shape[0] > 1 else 1
            segments.append(
                _segment_to_json(segment_states[idx], pdg, segment_states.shape[0], stride)
            )

        tracks.append(
            {
                "file": file_path,
                "dataset": name,
                "batch": batch,
                "generation": generation,
                "particleId": particle_id,
                "segments": segments,
            }
        )

    return {
        "files": files,
        "totalTracks": total_tracks,
        "offset": offset,
        "returnedTracks": len(tracks),
        "tracks": tracks,
    }


# ---------------------------------------------------------------------------
# Collision tracks (collision_track.h5)
# ---------------------------------------------------------------------------

# Columns exported to JSON (dataset field -> JSON key)
_COLLISION_COLUMNS = [
    ("E", "energies"),
    ("dE", "energyLosses"),
    ("time", "times"),
    ("wgt", "weights"),
    ("event_mt", "eventMt"),
    ("cell_id", "cellIds"),
    ("nuclide_id", "nuclideIds"),
    ("material_id", "materialIds"),
    ("particle", "particles"),
]


def read_collision_track_info(path):
    """Summary of an OpenMC collision track file (count + column names)."""
    _require_h5py()
    files = resolve_output_files(path, ("collision_track*.h5",))

    total = 0
    columns = []
    for file_path in files:
        with h5py.File(file_path, "r") as f:
            if "collision_track_bank" not in f:
                raise OutputReaderError(
                    f"No 'collision_track_bank' dataset in {file_path} "
                    f"(not an OpenMC collision track file?)"
                )
            bank = f["collision_track_bank"]
            total += int(bank.shape[0])
            if not columns:
                columns = list(bank.dtype.names or [])

    return {"files": files, "nCollisions": total, "columns": columns}


def read_collision_track_data(
    path,
    offset=0,
    limit=DEFAULT_COLLISION_LIMIT,
    mt_filter=None,
    cell_filter=None,
):
    """Read collision track rows with optional event-MT / cell-ID filters.

    ``offset``/``limit`` apply to the filtered rows and are enforced
    server-side. Returns flat JSON arrays aligned row-by-row.
    """
    _require_h5py()
    files = resolve_output_files(path, ("collision_track*.h5",))
    if offset < 0:
        raise OutputReaderError(f"offset must be >= 0, got {offset}")
    if limit is not None and limit <= 0:
        raise OutputReaderError(f"limit must be > 0, got {limit}")

    chunks = []
    total_collisions = 0
    for file_path in files:
        with h5py.File(file_path, "r") as f:
            if "collision_track_bank" not in f:
                raise OutputReaderError(
                    f"No 'collision_track_bank' dataset in {file_path} "
                    f"(not an OpenMC collision track file?)"
                )
            bank = f["collision_track_bank"]
            total_collisions += int(bank.shape[0])

            mask = None
            if mt_filter:
                mask = np.isin(bank["event_mt"][...], list(mt_filter))
            if cell_filter:
                cell_mask = np.isin(bank["cell_id"][...], list(cell_filter))
                mask = cell_mask if mask is None else (mask & cell_mask)

            if mask is None:
                chunks.append(bank[()])
            else:
                chunks.append(bank[mask])

    matched = np.concatenate(chunks) if chunks else np.zeros(0, dtype=[("event_mt", "i4")])
    matched_collisions = int(matched.shape[0])
    end = offset + limit if limit is not None else None
    selected = matched[offset:end]

    collisions = {}
    if selected.shape[0]:
        positions = np.column_stack([selected["r"]["x"], selected["r"]["y"], selected["r"]["z"]])
        collisions["positions"] = positions.tolist()
    else:
        collisions["positions"] = []
    for field, key in _COLLISION_COLUMNS:
        collisions[key] = selected[field].tolist() if selected.shape[0] else []

    return {
        "files": files,
        "totalCollisions": total_collisions,
        "matchedCollisions": matched_collisions,
        "offset": offset,
        "returned": int(selected.shape[0]),
        "collisions": collisions,
    }


# ---------------------------------------------------------------------------
# Weight windows (weight_windows.h5)
# ---------------------------------------------------------------------------


def _read_mesh_group(group):
    """Read a 'mesh <id>' group into a JSON-safe dict (any mesh type)."""
    name = group.name.split("/")[-1]
    mesh = {"id": int(name.removeprefix("mesh ")), "type": "regular"}
    for key in group.keys():
        value = group[key][()]
        if isinstance(value, np.ndarray):
            value = value.tolist()
        elif isinstance(value, bytes):
            value = value.decode("utf-8")
        elif isinstance(value, (np.integer, np.floating)):
            value = value.item()
        mesh[key] = value
    return mesh


def read_weight_windows(path):
    """Read an OpenMC weight_windows.h5 file.

    Lower/upper weight bounds are returned flat in the file's storage order:
    C-order with shape ``(n_energy, nz, ny, nx)`` (see ``boundsShape``), where
    ``(nx, ny, nz)`` is the mesh dimension and ``n_energy`` is
    ``len(energyBounds) - 1``.
    """
    _require_h5py()
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")

    with h5py.File(path, "r") as f:
        meshes = []
        mesh_dims = {}
        if "meshes" in f:
            for mesh_name in f["meshes"].keys():
                mesh = _read_mesh_group(f["meshes"][mesh_name])
                meshes.append(mesh)
                if "dimension" in mesh:
                    mesh_dims[mesh["id"]] = [int(d) for d in mesh["dimension"]]

        if "weight_windows" not in f:
            raise OutputReaderError(
                f"No 'weight_windows' group in {path} (not an OpenMC weight windows file?)"
            )

        windows = []
        for ww_name in f["weight_windows"].keys():
            group = f["weight_windows"][ww_name]
            ww_id = int(ww_name.split("/")[-1].replace("weight_windows_", ""))
            mesh_id = int(group["mesh"][()])
            energy_bounds = group["energy_bounds"][...]
            lower = group["lower_ww_bounds"][...]
            upper = group["upper_ww_bounds"][...]

            nx, ny, nz = mesh_dims.get(mesh_id, [0, 0, 0])
            n_energy = int(energy_bounds.shape[0] - 1)

            window = {
                "id": ww_id,
                "meshId": mesh_id,
                "particleType": _decode(group["particle_type"][()]),
                "energyBounds": energy_bounds.tolist(),
                "boundsShape": [n_energy, nz, ny, nx],
                "lowerBounds": lower.tolist(),
                "upperBounds": upper.tolist(),
                "survivalRatio": float(group["survival_ratio"][()]),
                "maxSplit": int(group["max_split"][()]),
                "weightCutoff": float(group["weight_cutoff"][()]),
            }
            if "max_lower_bound_ratio" in group:
                window["maxLowerBoundRatio"] = float(group["max_lower_bound_ratio"][()])
            else:
                window["maxLowerBoundRatio"] = None
            windows.append(window)

    return {"file": path, "meshes": meshes, "weightWindows": windows}


# ---------------------------------------------------------------------------
# Voxel plots (voxel .h5 from openmc.Plot / random-ray inputs)
# ---------------------------------------------------------------------------


def read_voxel_info(path):
    """Summary of an OpenMC voxel plot HDF5 file.

    Voxel files store grid geometry as file attributes (``num_voxels``,
    ``voxel_width``, ``lower_left``, ``version``) with a single ``data``
    dataset of domain IDs in (nz, ny, nx) order — see
    ``openmc.plots.voxel_to_vtk``.
    """
    _require_h5py()
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")

    with h5py.File(path, "r") as f:
        if "data" not in f or "num_voxels" not in f.attrs:
            raise OutputReaderError(
                f"No 'data' dataset / 'num_voxels' attribute in {path} "
                "(not an OpenMC voxel plot file?)"
            )
        data = f["data"][...]
        version = f.attrs["version"]
        return {
            "file": path,
            "version": [int(v) for v in np.atleast_1d(version)],
            "dimensions": [int(d) for d in f.attrs["num_voxels"]],
            "voxelWidth": [float(w) for w in f.attrs["voxel_width"]],
            "lowerLeft": [float(v) for v in f.attrs["lower_left"]],
            "idRange": [int(data.min()), int(data.max())],
            "uniqueIds": int(np.unique(data).shape[0]),
        }


# ---------------------------------------------------------------------------
# Particle restart files (particle_restart.h5 / particle_<batch>_<id>.h5)
# ---------------------------------------------------------------------------


def read_particle_restart(path):
    """Read an OpenMC particle restart file.

    Layout (OpenMC ``src/particle.cpp::Particle::write_restart``): file attrs
    ``filetype="particle restart"``, ``version=[2, 1]``; scalar datasets
    ``current_batch``, ``generations_per_batch``, ``current_generation``,
    ``n_particles``, ``run_mode`` (string), ``id`` (int64), ``type`` (int,
    PDG number), ``weight``, ``energy`` [eV], ``xyz`` (double[3], cm),
    ``uvw`` (double[3]), ``time`` [s]. Note: the file carries no cell or
    material IDs.
    """
    _require_h5py()
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")

    with h5py.File(path, "r") as f:
        required = ("current_batch", "current_generation", "id", "type", "energy", "xyz", "uvw")
        missing = [name for name in required if name not in f]
        if missing:
            raise OutputReaderError(
                f"Missing datasets {missing} in {path} (not an OpenMC particle restart file?)"
            )

        def _scalar(name, cast=float, default=None):
            if name not in f:
                return default
            return cast(f[name][()])

        return {
            "file": path,
            "filetype": _decode(f.attrs["filetype"]) if "filetype" in f.attrs else None,
            "version": [int(v) for v in np.atleast_1d(f.attrs["version"])]
            if "version" in f.attrs
            else None,
            "currentBatch": _scalar("current_batch", int),
            "currentGeneration": _scalar("current_generation", int),
            "generationsPerBatch": _scalar("generations_per_batch", int),
            "nParticles": _scalar("n_particles", int),
            "runMode": _decode(f["run_mode"][()]) if "run_mode" in f else None,
            "particleId": _scalar("id", int),
            "particle": _particle_name(_scalar("type", int)),
            "pdg": _scalar("type", int),
            "weight": _scalar("weight"),
            "energy": _scalar("energy"),
            "time": _scalar("time"),
            "position": [float(v) for v in f["xyz"][...]],
            "direction": [float(v) for v in f["uvw"][...]],
        }


# ---------------------------------------------------------------------------
# IFP kinetics parameters (from a statepoint)
# ---------------------------------------------------------------------------

_IFP_DENOMINATOR = "ifp-denominator"
_IFP_TIME_NUMERATOR = "ifp-time-numerator"
_IFP_BETA_NUMERATOR = "ifp-beta-numerator"


def _ufloat_to_pair(value):
    """Extract (nominal, std_dev) from an uncertainties ufloat or a plain number."""
    return float(getattr(value, "nominal_value", value)), float(getattr(value, "std_dev", 0.0))


def ratio_with_uncertainty(num_mean, num_std, den_mean, den_std):
    """Ratio of two independent measured quantities with 1-sigma uncertainties."""
    if den_mean == 0.0:
        raise OutputReaderError("Cannot compute kinetics parameters: ifp-denominator mean is zero")
    mean = num_mean / den_mean
    rel = 0.0
    if num_mean != 0.0:
        rel += (num_std / num_mean) ** 2
    rel += (den_std / den_mean) ** 2
    return mean, abs(mean) * math.sqrt(rel)


def _read_kinetics_openmc(path):
    """Compute kinetics parameters via openmc.StatePoint (returns None if unavailable)."""
    try:
        import openmc
    except ImportError:
        return None

    sp = openmc.StatePoint(path)
    params = sp.get_kinetics_parameters()

    if params.generation_time is None and params.beta_effective is None:
        raise OutputReaderError(
            f"No IFP tallies found in {path}: tallies with 'ifp-denominator', "
            "'ifp-time-numerator' and/or 'ifp-beta-numerator' scores are required"
        )

    generation_time = None
    if params.generation_time is not None:
        mean, std = _ufloat_to_pair(params.generation_time)
        generation_time = {"mean": mean, "stdDev": std}

    beta_total = None
    beta_groups = None
    if params.beta_effective is not None:
        beta = np.atleast_1d(params.beta_effective)
        pairs = [_ufloat_to_pair(v) for v in beta.flat]
        beta_groups = [{"mean": m, "stdDev": s} for m, s in pairs]
        # Total beta_eff: group values sum, independent stds add in quadrature
        total_mean = float(np.sum([m for m, _ in pairs]))
        total_std = float(np.sqrt(np.sum([s**2 for _, s in pairs])))
        beta_total = {"mean": total_mean, "stdDev": total_std}

    keff = None
    try:
        if sp.keff is not None:
            mean, std = _ufloat_to_pair(sp.keff)
            keff = {"mean": mean, "stdDev": std}
    except Exception:
        keff = None

    return {
        "file": path,
        "method": "openmc",
        "keff": keff,
        "betaEffective": beta_total,
        "betaEffectiveGroups": beta_groups,
        "generationTime": generation_time,
    }


def _find_ifp_tallies(f):
    """Locate IFP tallies in an open statepoint file.

    Returns a dict mapping score name -> (tally_group, score_index).
    """
    found = {}
    if "tallies" not in f:
        return found
    for key in f["tallies"].keys():
        if not key.startswith("tally "):
            continue
        group = f["tallies"][key]
        if "score_bins" not in group:
            continue
        scores = [_decode(s) for s in group["score_bins"][()]]
        for score in (_IFP_DENOMINATOR, _IFP_TIME_NUMERATOR, _IFP_BETA_NUMERATOR):
            if score in scores and score not in found:
                found[score] = (group, scores.index(score))
    return found


def _tally_score_moments(group, score_index):
    """Mean and std_dev for one score of a statepoint tally.

    Returns (mean, std) arrays shaped (n_filter_bins, n_nuclides). The
    statepoint 'results' dataset is (n_filter_bins * n_nuclides, n_scores, 2)
    holding [sum, sum_sq]; moments follow openmc/tallies.py.
    """
    results = group["results"]
    n_realizations = int(group["n_realizations"][()])
    n_scores = int(results.shape[1])
    if score_index >= n_scores:
        raise OutputReaderError(
            f"Score index {score_index} out of range for tally results with {n_scores} scores"
        )
    n_nuclides = 1
    if "nuclides" in group:
        n_nuclides = max(1, int(len(group["nuclides"][()])))
    sum_ = results[:, score_index, 0].reshape(-1, n_nuclides)
    sum_sq = results[:, score_index, 1].reshape(-1, n_nuclides)
    mean = sum_ / n_realizations
    std = np.zeros_like(mean)
    nonzero = np.abs(mean) > 0
    if n_realizations > 1:
        std[nonzero] = np.sqrt(
            (sum_sq[nonzero] / n_realizations - mean[nonzero] ** 2) / (n_realizations - 1)
        )
    return mean, std


def _delayed_group_count(f, tally_group):
    """Number of delayed-group bins if the tally's only filter is a DelayedGroupFilter."""
    if "filters" not in tally_group or "filters" not in f["tallies"]:
        return None
    filter_ids = [int(fid) for fid in tally_group["filters"][...]]
    if len(filter_ids) != 1:
        return None
    filter_key = f"filter {filter_ids[0]}"
    if filter_key not in f["tallies"]["filters"]:
        return None
    filter_group = f["tallies"]["filters"][filter_key]
    filter_type = ""
    if "type" in filter_group:
        filter_type = _decode(filter_group["type"][()])
    if filter_type != "delayedgroup":
        return None
    return int(filter_group["n_bins"][()])


def _read_kinetics_h5py(path):
    """h5py-only fallback computing IFP kinetics parameters from tally results."""
    with h5py.File(path, "r") as f:
        tallies = _find_ifp_tallies(f)
        if _IFP_DENOMINATOR not in tallies:
            raise OutputReaderError(
                f"No IFP tallies found in {path}: a tally with an "
                f"'{_IFP_DENOMINATOR}' score is required (run with IFP "
                "tallies enabled or install openmc for full parsing)"
            )

        denom_mean, denom_std = _tally_score_moments(*tallies[_IFP_DENOMINATOR])
        # Collapse filter bins and nuclides: totals sum, stds add in quadrature
        d_mean = float(denom_mean.sum())
        d_std = float(np.sqrt((denom_std**2).sum()))

        keff = None
        keff_mean = 1.0
        if "k_combined" in f:
            k_comb = f["k_combined"][...]
            keff_mean = float(k_comb[0])
            keff = {"mean": keff_mean, "stdDev": float(k_comb[1])}

        generation_time = None
        if _IFP_TIME_NUMERATOR in tallies:
            t_mean, t_std = _tally_score_moments(*tallies[_IFP_TIME_NUMERATOR])
            mean, std = ratio_with_uncertainty(
                float(t_mean.sum()),
                float(np.sqrt((t_std**2).sum())),
                d_mean,
                d_std,
            )
            generation_time = {"mean": mean / keff_mean, "stdDev": std / keff_mean}

        beta_total = None
        beta_groups = None
        if _IFP_BETA_NUMERATOR in tallies:
            group, score_index = tallies[_IFP_BETA_NUMERATOR]
            b_mean, b_std = _tally_score_moments(group, score_index)
            n_groups = _delayed_group_count(f, group)
            if n_groups is not None and b_mean.shape[0] == n_groups:
                # One filter bin per delayed group; sum over nuclides only
                beta_groups = []
                for g in range(n_groups):
                    mean, std = ratio_with_uncertainty(
                        float(b_mean[g].sum()),
                        float(np.sqrt((b_std[g] ** 2).sum())),
                        d_mean,
                        d_std,
                    )
                    beta_groups.append({"mean": mean, "stdDev": std})
                total_mean = float(np.sum([g["mean"] for g in beta_groups]))
                total_std = float(np.sqrt(np.sum([g["stdDev"] ** 2 for g in beta_groups])))
                beta_total = {"mean": total_mean, "stdDev": total_std}
            else:
                mean, std = ratio_with_uncertainty(
                    float(b_mean.sum()),
                    float(np.sqrt((b_std**2).sum())),
                    d_mean,
                    d_std,
                )
                beta_total = {"mean": mean, "stdDev": std}
                beta_groups = [beta_total]

    return {
        "file": path,
        "method": "h5py",
        "keff": keff,
        "betaEffective": beta_total,
        "betaEffectiveGroups": beta_groups,
        "generationTime": generation_time,
    }


def read_kinetics(path):
    """Read IFP kinetics parameters (beta_eff, Lambda_eff) from a statepoint.

    Prefers ``openmc.StatePoint.get_kinetics_parameters()`` when openmc is
    importable; falls back to a direct h5py computation from the tally
    results. Raises :class:`OutputReaderError` when neither path works.
    """
    _require_h5py()
    if not os.path.isfile(path):
        raise OutputReaderError(f"File not found: {path}")

    result = _read_kinetics_openmc(path)
    if result is not None:
        return result
    return _read_kinetics_h5py(path)
