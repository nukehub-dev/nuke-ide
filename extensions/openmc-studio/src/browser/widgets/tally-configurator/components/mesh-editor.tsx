// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

import * as React from 'react';
import { Tooltip, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import {
    OpenMCMesh,
    OpenMCMeshType,
    OpenMCRegularMesh,
    OpenMCRectilinearMesh,
    OpenMCCylindricalMesh,
    OpenMCSphericalMesh,
    OpenMCUnstructuredMesh,
    OpenMCUnstructuredMeshLibrary
} from '../../../../common/openmc-state-schema';
import {
    MESH_TYPE_LABELS,
    UNSTRUCTURED_MESH_EXTENSIONS,
    getMeshElementCount,
    inferUnstructuredMeshLibrary,
    validateMeshGrid,
    validateUnstructuredMeshFilename
} from '../../../../common/mesh-utils';
import { getMeshIcon, getMeshDescription } from './mesh-panel';

/** Filesystem status for an unstructured mesh file, resolved by the widget. */
export type MeshFileStatus = 'checking' | 'exists' | 'missing' | 'relative' | 'unknown';

/** Result of checking an unstructured mesh file on disk. */
export interface MeshFileInfo {
    /** Resolution outcome. */
    status: MeshFileStatus;
    /** File size in bytes when the file exists. */
    size?: number;
    /** Absolute or project-relative path that was checked. */
    checkedPath?: string;
    /** Optional check error (permission, remote file system, ...). */
    error?: string;
}

/**
 * Props for the {@link MeshEditor} component.
 */
interface MeshEditorProps {
    /** Mesh to edit */
    mesh: OpenMCMesh;
    /** Optional DAGMC geometry bounding box to auto-fill bounds */
    dagmcBoundingBox?: { min: [number, number, number]; max: [number, number, number] };
    /** Cached filesystem status for an unstructured mesh file */
    fileInfo?: MeshFileInfo;
    /** Open the file picker and store the chosen mesh file */
    onBrowseFile?: () => void;
    /** Re-check the configured mesh file on disk */
    onCheckFile?: () => void;
    /** Whether the `moab` Python package is importable (undefined = unchecked) */
    moabAvailable?: boolean;
    /** Whether the MOAB package check is running */
    moabChecking?: boolean;
    /** Run the MOAB package check */
    onCheckDependency?: () => void;
    /** Callback when mesh properties change */
    onUpdate: (updates: Partial<OpenMCMesh>) => void;
}

/** Selectable mesh types, ordered simple → advanced. */
const MESH_TYPE_CARDS: Array<{ type: OpenMCMeshType; label: string; hint: string; icon: string }> = [
    { type: 'regular', label: 'Regular', hint: 'Even Cartesian grid', icon: 'codicon-table' },
    { type: 'rectilinear', label: 'Rectilinear', hint: 'Custom axis boundaries', icon: 'codicon-list-unordered' },
    { type: 'cylindrical', label: 'Cylindrical', hint: 'r, φ, z grid', icon: 'codicon-circle-outline' },
    { type: 'spherical', label: 'Spherical', hint: 'r, θ, φ grid', icon: 'codicon-globe' },
    { type: 'unstructured', label: 'Unstructured', hint: 'MOAB / Exodus file', icon: 'codicon-file-binary' }
];

/**
 * Editor for configuring an OpenMC mesh.
 *
 * Supports regular (Cartesian), rectilinear, cylindrical, spherical, and
 * unstructured meshes. Rectilinear grids use a token editor with a
 * bounds + divisions helper; unstructured meshes use a file picker with
 * library-aware validation.
 *
 * @see {@link MeshPanel}
 */
export const MeshEditor: React.FC<MeshEditorProps> = ({
    mesh,
    dagmcBoundingBox,
    fileInfo,
    onBrowseFile,
    onCheckFile,
    moabAvailable,
    moabChecking,
    onCheckDependency,
    onUpdate
}) => {
    /** Handle switching the mesh coordinate system type. */
    const handleTypeChange = (value: string) => {
        const newType = value as OpenMCMeshType;
        if (newType === mesh.type) return;

        // Preserve identity, reset type-specific geometry to safe defaults.
        const base = { id: mesh.id, name: mesh.name };
        let newMesh: OpenMCMesh;

        if (newType === 'regular') {
            newMesh = { ...base, type: 'regular', lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10], dimension: [10, 10, 10] };
        } else if (newType === 'rectilinear') {
            newMesh = { ...base, type: 'rectilinear', xGrid: [-10, 0, 10], yGrid: [-10, 0, 10], zGrid: [-10, 0, 10] };
        } else if (newType === 'cylindrical') {
            newMesh = { ...base, type: 'cylindrical', rGrid: [0, 10], phiGrid: [0, 6.28318530718], zGrid: [-10, 10] };
        } else if (newType === 'spherical') {
            newMesh = { ...base, type: 'spherical', rGrid: [0, 10], thetaGrid: [0, 3.14159265359], phiGrid: [0, 6.28318530718] };
        } else {
            newMesh = { ...base, type: 'unstructured', filename: '', library: 'moab' };
        }
        onUpdate(newMesh);
    };

    return (
        <div className="mesh-editor">
            <div className="editor-header">
                <h3>
                    <i className="codicon codicon-table"></i>
                    Edit Mesh #{mesh.id}
                </h3>
                <p className="editor-description">Configure mesh geometry for spatial tallying</p>
            </div>

            <div className="mesh-summary">
                <span className={`mesh-type-badge ${mesh.type}`}>
                    <i className={`codicon ${getMeshIcon(mesh.type)}`}></i>
                    {MESH_TYPE_LABELS[mesh.type]}
                </span>
                <span className="mesh-summary-text">{getMeshDescription(mesh)}</span>
            </div>

            <div className="editor-sections">
                <div className="editor-section">
                    <h4>
                        <i className="codicon codicon-settings-gear"></i>
                        Mesh Settings
                    </h4>
                    <p className="section-description">Define the mesh name and coordinate system for spatial tallying.</p>
                    <div className="form-group">
                        <label>Name</label>
                        <input
                            type="text"
                            value={mesh.name || ''}
                            onChange={(e) => onUpdate({ name: e.target.value })}
                            placeholder={`Mesh ${mesh.id}`}
                        />
                        <p className="form-hint">Optional descriptive name for this mesh</p>
                    </div>
                    <div className="form-group">
                        <Tooltip content="Coordinate system for spatial discretization" position="top">
                            <label>Type</label>
                        </Tooltip>
                        <div className="mesh-type-cards" role="radiogroup" aria-label="Mesh type">
                            {MESH_TYPE_CARDS.map((card) => (
                                <button
                                    key={card.type}
                                    type="button"
                                    role="radio"
                                    aria-checked={mesh.type === card.type}
                                    data-mesh-type={card.type}
                                    className={`mesh-type-card ${mesh.type === card.type ? 'active' : ''}`}
                                    onClick={() => handleTypeChange(card.type)}
                                >
                                    <i className={`codicon ${card.icon}`}></i>
                                    <span className="mesh-type-card-label">{card.label}</span>
                                    <span className="mesh-type-card-hint">{card.hint}</span>
                                </button>
                            ))}
                        </div>
                        <div className="mesh-type-select">
                            <NukeSelect
                                value={mesh.type}
                                options={MESH_TYPE_CARDS.map((card) => ({ value: card.type, label: MESH_TYPE_LABELS[card.type] }))}
                                onChange={handleTypeChange}
                                ariaLabel="Mesh type"
                            />
                        </div>
                        <p className="form-hint">Choose the grid that matches how you want to discretize the model</p>
                    </div>
                </div>

                {mesh.type === 'regular' && (
                    <div className="editor-section">
                        <h4>
                            <i className="codicon codicon-graph"></i>
                            Cartesian Grid
                        </h4>
                        <p className="section-description">Define bounding box and number of cells in X, Y, Z directions.</p>
                        {renderRegularMeshEditor(mesh as OpenMCRegularMesh, onUpdate, dagmcBoundingBox)}
                    </div>
                )}

                {mesh.type === 'rectilinear' && (
                    <div className="editor-section">
                        <h4>
                            <i className="codicon codicon-list-unordered"></i>
                            Rectilinear Grid
                        </h4>
                        <p className="section-description">
                            Enter explicit boundaries per axis. Each axis needs at least two strictly increasing values; neighboring
                            boundaries define one cell.
                        </p>
                        <RectilinearMeshEditor mesh={mesh as OpenMCRectilinearMesh} onUpdate={onUpdate} />
                    </div>
                )}

                {mesh.type === 'cylindrical' && (
                    <div className="editor-section">
                        <h4>
                            <i className="codicon codicon-circle-outline"></i>
                            Cylindrical Grid
                        </h4>
                        <p className="section-description">
                            Define grid boundaries in cylindrical coordinates: r (radius), φ (azimuthal), z (vertical).
                        </p>
                        {renderCylindricalMeshEditor(mesh as OpenMCCylindricalMesh, onUpdate)}
                    </div>
                )}

                {mesh.type === 'spherical' && (
                    <div className="editor-section">
                        <h4>
                            <i className="codicon codicon-globe"></i>
                            Spherical Grid
                        </h4>
                        <p className="section-description">
                            Define grid boundaries in spherical coordinates: r (radius), θ (polar), φ (azimuthal).
                        </p>
                        {renderSphericalMeshEditor(mesh as OpenMCSphericalMesh, onUpdate)}
                    </div>
                )}

                {mesh.type === 'unstructured' && (
                    <div className="editor-section">
                        <h4>
                            <i className="codicon codicon-file-binary"></i>
                            Unstructured Mesh
                        </h4>
                        <p className="section-description">
                            Reference an external mesh file. OpenMC reads the file at run time; the mesh is not editable in the IDE.
                        </p>
                        <UnstructuredMeshEditor
                            mesh={mesh as OpenMCUnstructuredMesh}
                            fileInfo={fileInfo}
                            onBrowseFile={onBrowseFile}
                            onCheckFile={onCheckFile}
                            moabAvailable={moabAvailable}
                            moabChecking={moabChecking}
                            onCheckDependency={onCheckDependency}
                            onUpdate={onUpdate}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * Rectilinear editor: three token grids plus a bounds + divisions helper.
 *
 * @param props - Mesh and update callback.
 */
const RectilinearMeshEditor: React.FC<{
    mesh: OpenMCRectilinearMesh;
    onUpdate: (updates: Partial<OpenMCMesh>) => void;
}> = ({ mesh, onUpdate }) => {
    const total = getMeshElementCount(mesh);
    return (
        <div className="mesh-type-editor">
            <div className="mesh-grid-editors">
                <GridTokenEditor
                    axis="x"
                    label="X"
                    values={mesh.xGrid}
                    hint="X boundaries (cm)"
                    onChange={(xGrid) => onUpdate({ xGrid })}
                />
                <GridTokenEditor
                    axis="y"
                    label="Y"
                    values={mesh.yGrid}
                    hint="Y boundaries (cm)"
                    onChange={(yGrid) => onUpdate({ yGrid })}
                />
                <GridTokenEditor
                    axis="z"
                    label="Z"
                    values={mesh.zGrid}
                    hint="Z boundaries (cm)"
                    onChange={(zGrid) => onUpdate({ zGrid })}
                />
            </div>
            <div className="mesh-grid-stats" aria-live="polite">
                <span>
                    Cells: {Math.max(mesh.xGrid.length - 1, 0)} × {Math.max(mesh.yGrid.length - 1, 0)} ×{' '}
                    {Math.max(mesh.zGrid.length - 1, 0)}
                </span>
                <span>Total elements: {total ?? 0}</span>
            </div>
            <BoundsDivisionsHelper mesh={mesh} onApply={(xGrid, yGrid, zGrid) => onUpdate({ xGrid, yGrid, zGrid })} />
        </div>
    );
};

/**
 * Parse a token/space/comma-separated numeric grid.
 *
 * @param text - Raw input.
 * @returns Parsed values and an error when a token is not numeric.
 */
function parseGridText(text: string): { values: number[]; error?: string } {
    const tokens = text
        .trim()
        .split(/[\s,]+/)
        .filter((token) => token.length > 0);
    const values = tokens.map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
        return { values: [], error: 'Use numbers separated by spaces or commas' };
    }
    return { values };
}

/**
 * Compact token editor for one rectilinear grid axis.
 *
 * Committed values live in project state; raw text stays local so invalid
 * tokens are shown with an error instead of being silently discarded.
 *
 * @param props - Axis, values, and change callback.
 */
const GridTokenEditor: React.FC<{
    axis: 'x' | 'y' | 'z';
    label: string;
    values: number[];
    hint: string;
    onChange: (values: number[]) => void;
}> = ({ axis, label, values, hint, onChange }) => {
    const [raw, setRaw] = React.useState(values.join(' '));
    const [inputError, setInputError] = React.useState<string | undefined>();
    const lastValues = React.useRef(values);

    React.useEffect(() => {
        if (values !== lastValues.current) {
            lastValues.current = values;
            setRaw(values.join(' '));
            setInputError(undefined);
        }
    }, [values]);

    const validation = validateMeshGrid(values);

    const commit = (text: string) => {
        setRaw(text);
        const parsed = parseGridText(text);
        if (parsed.error) {
            setInputError(parsed.error);
            return;
        }
        setInputError(undefined);
        lastValues.current = parsed.values;
        onChange(parsed.values);
    };

    const removeToken = (index: number) => {
        const next = values.filter((_, i) => i !== index);
        lastValues.current = next;
        setRaw(next.join(' '));
        onChange(next);
    };

    return (
        <div className={`mesh-grid-editor ${validation ? 'invalid' : ''}`} data-axis={axis}>
            <div className="mesh-grid-header">
                <label htmlFor={`mesh-grid-${axis}`}>{label} boundaries</label>
                <span className="mesh-grid-count">{Math.max(values.length - 1, 0)} cells</span>
            </div>
            <input
                id={`mesh-grid-${axis}`}
                type="text"
                className="mesh-grid-input"
                value={raw}
                onChange={(e) => commit(e.target.value)}
                placeholder="e.g. -10 0 10"
                aria-invalid={!!validation || !!inputError}
                aria-describedby={`mesh-grid-${axis}-hint`}
            />
            <p className="form-hint" id={`mesh-grid-${axis}-hint`}>
                {hint} — space or comma separated
            </p>
            {values.length > 0 && (
                <div className="mesh-grid-tokens" aria-label={`${label} grid values`}>
                    {values.map((value, index) => (
                        <span className="mesh-grid-token" key={`${index}-${value}`}>
                            {value}
                            <Tooltip content={`Remove ${label} boundary ${value}`} position="top">
                                <button
                                    type="button"
                                    className="mesh-grid-token-remove"
                                    aria-label={`Remove ${label} boundary ${value}`}
                                    onClick={() => removeToken(index)}
                                >
                                    <i className="codicon codicon-close"></i>
                                </button>
                            </Tooltip>
                        </span>
                    ))}
                </div>
            )}
            {(inputError || validation) && (
                <p className="validation-error">
                    <i className="codicon codicon-error"></i>
                    {inputError ?? validation}
                </p>
            )}
        </div>
    );
};

/**
 * Fill all three rectilinear grids from lower/upper bounds and a cell count.
 *
 * @param props - Current mesh and apply callback.
 */
const BoundsDivisionsHelper: React.FC<{
    mesh: OpenMCRectilinearMesh;
    onApply: (xGrid: number[], yGrid: number[], zGrid: number[]) => void;
}> = ({ mesh, onApply }) => {
    const boundsFor = (grid: number[]): { lower: number; upper: number; count: number } => ({
        lower: grid[0] ?? 0,
        upper: grid[grid.length - 1] ?? 1,
        count: Math.max(grid.length - 1, 1)
    });
    const [rows, setRows] = React.useState({
        x: boundsFor(mesh.xGrid),
        y: boundsFor(mesh.yGrid),
        z: boundsFor(mesh.zGrid)
    });
    const [error, setError] = React.useState<string | undefined>();

    const updateRow = (axis: 'x' | 'y' | 'z', field: 'lower' | 'upper' | 'count', value: string) => {
        const parsed = field === 'count' ? parseInt(value, 10) : parseFloat(value);
        setRows((current) => ({ ...current, [axis]: { ...current[axis], [field]: Number.isFinite(parsed) ? parsed : 0 } }));
    };

    const apply = () => {
        for (const axis of ['x', 'y', 'z'] as const) {
            const row = rows[axis];
            if (!Number.isFinite(row.lower) || !Number.isFinite(row.upper) || row.lower >= row.upper) {
                setError(`${axis.toUpperCase()} lower bound must be below the upper bound`);
                return;
            }
            if (!Number.isInteger(row.count) || row.count < 1) {
                setError(`${axis.toUpperCase()} divisions must be a whole number of at least 1`);
                return;
            }
        }
        const linspace = (row: { lower: number; upper: number; count: number }) =>
            Array.from({ length: row.count + 1 }, (_, index) => row.lower + ((row.upper - row.lower) * index) / row.count);
        setError(undefined);
        onApply(linspace(rows.x), linspace(rows.y), linspace(rows.z));
    };

    return (
        <div className="mesh-grid-helper">
            <div className="mesh-grid-helper-header">
                <span>
                    <i className="codicon codicon-symbol-ruler"></i> From bounds + divisions
                </span>
                <span className="form-hint">Replaces all three grids with evenly spaced boundaries</span>
            </div>
            <div className="mesh-grid-helper-rows">
                {(['x', 'y', 'z'] as const).map((axis) => (
                    <div className="mesh-grid-helper-row" key={axis}>
                        <span className="mesh-grid-helper-axis">{axis.toUpperCase()}</span>
                        <label>
                            Lower
                            <input
                                type="number"
                                step="any"
                                aria-label={`${axis.toUpperCase()} lower bound`}
                                value={rows[axis].lower}
                                onChange={(e) => updateRow(axis, 'lower', e.target.value)}
                            />
                        </label>
                        <label>
                            Upper
                            <input
                                type="number"
                                step="any"
                                aria-label={`${axis.toUpperCase()} upper bound`}
                                value={rows[axis].upper}
                                onChange={(e) => updateRow(axis, 'upper', e.target.value)}
                            />
                        </label>
                        <label>
                            Divisions
                            <input
                                type="number"
                                min={1}
                                step={1}
                                aria-label={`${axis.toUpperCase()} divisions`}
                                value={rows[axis].count}
                                onChange={(e) => updateRow(axis, 'count', e.target.value)}
                            />
                        </label>
                    </div>
                ))}
            </div>
            {error && (
                <p className="validation-error">
                    <i className="codicon codicon-error"></i>
                    {error}
                </p>
            )}
            <button type="button" className="add-button mesh-grid-helper-apply" onClick={apply}>
                <i className="codicon codicon-checklist"></i> Apply to grids
            </button>
        </div>
    );
};

/**
 * Unstructured mesh editor: file picker, library, scale, and MOAB options.
 *
 * @param props - Mesh, filesystem status, and callbacks.
 */
const UnstructuredMeshEditor: React.FC<{
    mesh: OpenMCUnstructuredMesh;
    fileInfo?: MeshFileInfo;
    onBrowseFile?: () => void;
    onCheckFile?: () => void;
    moabAvailable?: boolean;
    moabChecking?: boolean;
    onCheckDependency?: () => void;
    onUpdate: (updates: Partial<OpenMCMesh>) => void;
}> = ({ mesh, fileInfo, onBrowseFile, onCheckFile, moabAvailable, moabChecking, onCheckDependency, onUpdate }) => {
    const filenameError = validateUnstructuredMeshFilename(mesh.filename, mesh.library);
    const lengthMultiplier = mesh.lengthMultiplier ?? 1;
    const lengthError =
        !Number.isFinite(lengthMultiplier) || lengthMultiplier <= 0 ? 'Length multiplier must be greater than 0' : undefined;
    const extensionHint = UNSTRUCTURED_MESH_EXTENSIONS[mesh.library].map((extension) => `.${extension}`).join(', ');

    const handleFilenameChange = (filename: string) => {
        const inferred = inferUnstructuredMeshLibrary(filename);
        onUpdate(inferred && inferred !== mesh.library ? { filename, library: inferred } : { filename });
    };

    const handleLibraryChange = (library: OpenMCUnstructuredMeshLibrary) => {
        onUpdate({ library });
    };

    return (
        <div className="mesh-type-editor mesh-unstructured-editor">
            <div className="form-group">
                <label htmlFor="mesh-file-input">Mesh file</label>
                <div className="mesh-file-row">
                    <input
                        id="mesh-file-input"
                        type="text"
                        className="mesh-file-input"
                        value={mesh.filename}
                        onChange={(e) => handleFilenameChange(e.target.value)}
                        placeholder="e.g. meshes/core.h5m"
                    />
                    <Tooltip content="Choose an unstructured mesh file" position="top">
                        <button type="button" className="add-button mesh-file-browse" onClick={onBrowseFile} disabled={!onBrowseFile}>
                            <i className="codicon codicon-folder-opened"></i> Browse
                        </button>
                    </Tooltip>
                    {onCheckFile && (
                        <Tooltip content="Check the file again on disk" position="top">
                            <button type="button" className="mesh-file-recheck" aria-label="Recheck mesh file" onClick={onCheckFile}>
                                <i className="codicon codicon-refresh"></i>
                            </button>
                        </Tooltip>
                    )}
                </div>
                {filenameError ? (
                    <p className="validation-error">
                        <i className="codicon codicon-error"></i>
                        {filenameError}
                    </p>
                ) : (
                    <p className="form-hint">Stored project-relative when the file lives beside the project.</p>
                )}
                {renderFileStatus(fileInfo)}
            </div>

            <div className="form-row">
                <div className="form-group">
                    <Tooltip content="OpenMC reads the file with this mesh library" position="top">
                        <label>Library</label>
                    </Tooltip>
                    <NukeSelect
                        value={mesh.library}
                        options={[
                            { value: 'moab', label: 'MOAB (HDF5, VTK, Exodus)' },
                            { value: 'libmesh', label: 'libMesh (Exodus)' }
                        ]}
                        onChange={(value: string) => handleLibraryChange(value as OpenMCUnstructuredMeshLibrary)}
                        ariaLabel="Mesh library"
                    />
                    <p className="form-hint">Accepted extensions: {extensionHint}</p>
                </div>
                <div className="form-group">
                    <Tooltip content="Scale every mesh coordinate by this factor" position="top">
                        <label>Length multiplier</label>
                    </Tooltip>
                    <input
                        type="number"
                        className="mesh-length-multiplier"
                        min="0"
                        step="any"
                        value={lengthMultiplier}
                        onChange={(e) => {
                            const value = parseFloat(e.target.value);
                            onUpdate({ lengthMultiplier: Number.isFinite(value) && value !== 1 ? value : undefined });
                        }}
                    />
                    <p className="form-hint">Default 1 (no scaling); use 100 for meshes authored in metres.</p>
                    {lengthError && (
                        <p className="validation-error">
                            <i className="codicon codicon-error"></i>
                            {lengthError}
                        </p>
                    )}
                </div>
            </div>

            <div className="form-group">
                <Tooltip content="MOAB AdaptiveKDTree search parameters; leave empty for the OpenMC default" position="top">
                    <label>Advanced options</label>
                </Tooltip>
                <input
                    type="text"
                    className="mesh-options-input"
                    value={mesh.options ?? ''}
                    onChange={(e) => onUpdate({ options: e.target.value || undefined })}
                    placeholder="MAX_DEPTH=20;PLANE_SET=2;"
                />
                <p className="form-hint">MOAB only. Empty uses OpenMC's default search tree settings.</p>
            </div>

            <div className={`mesh-dependency-hint ${mesh.library === 'moab' && moabAvailable === false ? 'warning' : ''}`}>
                <i className={`codicon ${mesh.library === 'moab' && moabAvailable === false ? 'codicon-warning' : 'codicon-info'}`}></i>
                <span>
                    {mesh.library === 'moab'
                        ? moabAvailable === false
                            ? 'The moab package is not importable in the configured Python environment. Unstructured tallies also need an OpenMC build compiled with MOAB support.'
                            : moabAvailable === true
                              ? 'The moab package is available. Unstructured tallies also need an OpenMC build compiled with MOAB support.'
                              : 'MOAB unstructured tallies need an OpenMC build compiled with MOAB support; the moab Python package covers companion tooling.'
                        : 'libMesh support is compiled into OpenMC. Use an OpenMC build configured with libMesh before running this mesh.'}
                </span>
                {mesh.library === 'moab' && onCheckDependency && moabAvailable === undefined && (
                    <button type="button" className="mesh-dependency-check" onClick={onCheckDependency} disabled={moabChecking}>
                        {moabChecking ? (
                            <>
                                <i className="codicon codicon-loading codicon-modifier-spin"></i> Checking…
                            </>
                        ) : (
                            'Check environment'
                        )}
                    </button>
                )}
            </div>
        </div>
    );
};

/**
 * Render the cached filesystem status for an unstructured mesh.
 *
 * @param fileInfo - Status returned by the widget's file check.
 */
function renderFileStatus(fileInfo?: MeshFileInfo): React.ReactNode {
    if (!fileInfo) {
        return null;
    }
    if (fileInfo.status === 'checking') {
        return (
            <p className="mesh-file-status">
                <i className="codicon codicon-loading codicon-modifier-spin"></i>
                Checking file…
            </p>
        );
    }
    if (fileInfo.status === 'exists') {
        return (
            <p className="mesh-file-status ok">
                <i className="codicon codicon-check"></i>
                {formatBytes(fileInfo.size)}
            </p>
        );
    }
    if (fileInfo.status === 'relative') {
        return (
            <p className="mesh-file-status">
                <i className="codicon codicon-info"></i>
                Project-relative path; existence is verified when the project is exported or run.
            </p>
        );
    }
    if (fileInfo.status === 'missing') {
        return (
            <p className="mesh-file-warning">
                <i className="codicon codicon-warning"></i>
                File not found{fileInfo.checkedPath ? `: ${fileInfo.checkedPath}` : ''}. Choose the file again or copy it back.
            </p>
        );
    }
    return (
        <p className="mesh-file-status">
            <i className="codicon codicon-info"></i>
            File could not be checked{fileInfo.error ? `: ${fileInfo.error}` : ''}.
        </p>
    );
}

/**
 * Format a byte count for the file status line.
 *
 * @param bytes - File size in bytes.
 * @returns Human-readable size, or an empty string when unknown.
 */
function formatBytes(bytes?: number): string {
    if (bytes === undefined || !Number.isFinite(bytes)) {
        return 'File found';
    }
    if (bytes < 1024) {
        return `File found · ${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `File found · ${(bytes / 1024).toFixed(1)} KB`;
    }
    return `File found · ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render editor controls for a regular (Cartesian) mesh.
 * @param mesh - The regular mesh to edit.
 * @param onUpdate - Update callback.
 * @param dagmcBoundingBox - Optional geometry bounds for auto-fill.
 */
function renderRegularMeshEditor(
    mesh: OpenMCRegularMesh,
    onUpdate: (updates: Partial<OpenMCRegularMesh>) => void,
    dagmcBoundingBox?: { min: [number, number, number]; max: [number, number, number] }
) {
    const updateCoord = (field: 'lowerLeft' | 'upperRight', index: number, value: string) => {
        const num = parseFloat(value);
        if (isNaN(num)) return;
        const newCoords = [...mesh[field]] as [number, number, number];
        newCoords[index] = num;
        onUpdate({ [field]: newCoords });
    };

    const updateDim = (index: number, value: string) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return;
        const newDim = [...mesh.dimension] as [number, number, number];
        newDim[index] = num;
        onUpdate({ dimension: newDim });
    };

    const setFromGeometry = () => {
        if (dagmcBoundingBox) {
            onUpdate({
                lowerLeft: [...dagmcBoundingBox.min],
                upperRight: [...dagmcBoundingBox.max]
            });
        }
    };

    return (
        <div className="mesh-type-editor">
            {dagmcBoundingBox && (
                <div className="editor-toolbar">
                    <Tooltip content="Set mesh bounds from DAGMC geometry bounding box" position="top">
                        <button className="add-button" onClick={setFromGeometry}>
                            <i className="codicon codicon-target"></i> Set from Geometry Bounds
                        </button>
                    </Tooltip>
                </div>
            )}
            <div className="form-row">
                <div className="form-group">
                    <label>Lower Left (x, y, z)</label>
                    <div className="coord-inputs">
                        <input type="number" value={mesh.lowerLeft[0]} onChange={(e) => updateCoord('lowerLeft', 0, e.target.value)} />
                        <input type="number" value={mesh.lowerLeft[1]} onChange={(e) => updateCoord('lowerLeft', 1, e.target.value)} />
                        <input type="number" value={mesh.lowerLeft[2]} onChange={(e) => updateCoord('lowerLeft', 2, e.target.value)} />
                    </div>
                    <p className="form-hint">Minimum coordinates of bounding box (cm)</p>
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Upper Right (x, y, z)</label>
                    <div className="coord-inputs">
                        <input type="number" value={mesh.upperRight[0]} onChange={(e) => updateCoord('upperRight', 0, e.target.value)} />
                        <input type="number" value={mesh.upperRight[1]} onChange={(e) => updateCoord('upperRight', 1, e.target.value)} />
                        <input type="number" value={mesh.upperRight[2]} onChange={(e) => updateCoord('upperRight', 2, e.target.value)} />
                    </div>
                    <p className="form-hint">Maximum coordinates of bounding box (cm)</p>
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Dimension (nx, ny, nz)</label>
                    <div className="coord-inputs">
                        <input type="number" value={mesh.dimension[0]} onChange={(e) => updateDim(0, e.target.value)} min="1" />
                        <input type="number" value={mesh.dimension[1]} onChange={(e) => updateDim(1, e.target.value)} min="1" />
                        <input type="number" value={mesh.dimension[2]} onChange={(e) => updateDim(2, e.target.value)} min="1" />
                    </div>
                    <p className="form-hint">Number of mesh cells in each direction (must be ≥1)</p>
                </div>
            </div>
        </div>
    );
}

/**
 * Render editor controls for a cylindrical mesh.
 * @param mesh - The cylindrical mesh to edit.
 * @param onUpdate - Update callback.
 */
function renderCylindricalMeshEditor(mesh: OpenMCCylindricalMesh, onUpdate: (updates: Partial<OpenMCCylindricalMesh>) => void) {
    const handleGridChange = (field: 'rGrid' | 'phiGrid' | 'zGrid', value: string) => {
        const parts = value
            .split(/\s+/)
            .map((p) => parseFloat(p))
            .filter((p) => !isNaN(p));
        onUpdate({ [field]: parts });
    };

    return (
        <div className="mesh-type-editor">
            <div className="form-group">
                <label>r-Grid (boundaries)</label>
                <input
                    type="text"
                    value={mesh.rGrid.join(' ')}
                    onChange={(e) => handleGridChange('rGrid', e.target.value)}
                    placeholder="e.g. 0 5 10"
                />
                <p className="form-hint">Radial grid boundaries (cm), space-separated values</p>
            </div>
            <div className="form-group">
                <label>phi-Grid (boundaries in radians)</label>
                <input
                    type="text"
                    value={mesh.phiGrid.join(' ')}
                    onChange={(e) => handleGridChange('phiGrid', e.target.value)}
                    placeholder="e.g. 0 1.57 3.14 4.71 6.28"
                />
                <p className="form-hint">Azimuthal grid boundaries (radians), 0 to 2π, space-separated</p>
            </div>
            <div className="form-group">
                <label>z-Grid (boundaries)</label>
                <input
                    type="text"
                    value={mesh.zGrid.join(' ')}
                    onChange={(e) => handleGridChange('zGrid', e.target.value)}
                    placeholder="e.g. -10 0 10"
                />
                <p className="form-hint">Vertical grid boundaries (cm), space-separated values</p>
            </div>
        </div>
    );
}

/**
 * Render editor controls for a spherical mesh.
 * @param mesh - The spherical mesh to edit.
 * @param onUpdate - Update callback.
 */
function renderSphericalMeshEditor(mesh: OpenMCSphericalMesh, onUpdate: (updates: Partial<OpenMCSphericalMesh>) => void) {
    const handleGridChange = (field: 'rGrid' | 'thetaGrid' | 'phiGrid', value: string) => {
        const parts = value
            .split(/\s+/)
            .map((p) => parseFloat(p))
            .filter((p) => !isNaN(p));
        onUpdate({ [field]: parts });
    };

    return (
        <div className="mesh-type-editor">
            <div className="form-group">
                <label>r-Grid (boundaries)</label>
                <input
                    type="text"
                    value={mesh.rGrid.join(' ')}
                    onChange={(e) => handleGridChange('rGrid', e.target.value)}
                    placeholder="e.g. 0 5 10"
                />
                <p className="form-hint">Radial grid boundaries (cm), space-separated values</p>
            </div>
            <div className="form-group">
                <label>theta-Grid (boundaries in radians, 0 to π)</label>
                <input
                    type="text"
                    value={mesh.thetaGrid.join(' ')}
                    onChange={(e) => handleGridChange('thetaGrid', e.target.value)}
                    placeholder="e.g. 0 1.57 3.14"
                />
                <p className="form-hint">Polar angle grid boundaries (radians), 0 to π, space-separated</p>
            </div>
            <div className="form-group">
                <label>phi-Grid (boundaries in radians, 0 to 2π)</label>
                <input
                    type="text"
                    value={mesh.phiGrid.join(' ')}
                    onChange={(e) => handleGridChange('phiGrid', e.target.value)}
                    placeholder="e.g. 0 3.14 6.28"
                />
                <p className="form-hint">Azimuthal grid boundaries (radians), 0 to 2π, space-separated</p>
            </div>
        </div>
    );
}
