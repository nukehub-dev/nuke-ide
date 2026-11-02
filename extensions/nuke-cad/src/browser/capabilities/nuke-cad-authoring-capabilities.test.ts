// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/filesystem/lib/browser/file-dialog', () => ({ FileDialogService: Symbol('FileDialogService') }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));
vi.mock('@theia/monaco/lib/browser/monaco-workspace', () => ({ MonacoWorkspace: class MonacoWorkspace {} }));

import { URI } from '@theia/core/lib/common/uri';
import type { CommandService } from '@theia/core/lib/common/command';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { MonacoWorkspace } from '@theia/monaco/lib/browser/monaco-workspace';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeCadDocument, SketchDef } from '../../common/cad-document';
import type { TopologyRef } from '../../common/topology-refs';
import type {
    GeometryBuildResult,
    ImportSolidInfo,
    InspectImportSourceRequest,
    InspectImportSourceResult,
    RegionManifestData,
    SandboxedScriptBuildRequest,
    SandboxedScriptBuildResult,
    ScriptSandboxStatus
} from '../../common/nuke-cad-protocol';
import type { CadDocumentStore, ImportBodyDraft, ImportBodiesRequest } from '../document/cad-document-store';
import type { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import type { NukeCadPreferences } from '../nuke-cad-preferences';
import type { CadModel, NukeCadStateManager, SolidSummary } from '../state/nuke-cad-state-manager';
import {
    APPLY_ASSEMBLY_CHANGE_ID,
    APPLY_DRAWING_CHANGE_ID,
    APPLY_FEATURE_CHANGE_ID,
    APPLY_IMPORT_BODIES_ID,
    APPLY_SCRIPT_CHANGE_ID,
    APPLY_SKETCH_CHANGE_ID,
    APPLY_TOPOLOGY_CHANGE_ID,
    INSPECT_IMPORT_SOURCE_ID,
    INSPECT_SCRIPT_SOURCE_ID,
    LIST_SKETCH_DIMENSIONS_ID,
    NukeCadAuthoringCapabilities,
    PREVIEW_ASSEMBLY_CHANGE_ID,
    PREVIEW_DRAWING_CHANGE_ID,
    PREVIEW_FEATURE_CHANGE_ID,
    PREVIEW_IMPORT_BODIES_ID,
    PREVIEW_SCRIPT_CHANGE_ID,
    PREVIEW_SKETCH_CHANGE_ID,
    PREVIEW_TOPOLOGY_CHANGE_ID,
    SCRIPT_AUTHORING_PREFERENCE,
    SUMMARIZE_ASSEMBLY_ID,
    SUMMARIZE_DRAWING_ID,
    readAssemblyActions,
    readDrawingChangeActions,
    readFeatureParamChanges,
    readImportPreviewInput,
    readInspectImportSourceInput,
    readScriptApplyInput,
    readScriptPreviewInput,
    readSketchEditRequests,
    readTopologyActions,
    validateAssemblyCandidateBuild
} from './nuke-cad-authoring-capabilities';
import {
    isAssemblyProposal,
    isDrawingProposal,
    isImportProposal,
    isScriptProposal,
    isSketchProposal,
    isTopologyProposal,
    NukeCadAssemblyProposalDetails,
    NukeCadProposalService,
    NukeCadScriptProposal
} from './nuke-cad-proposal-service';
import type { AssemblyChangeInput } from '../../common/cad-assembly-edit';
import type { DrawingChangeAction } from '../../common/cad-drawing-edit';
import type { AssemblySection } from '../document/cad-document-store';
import type { NukeCadGhostPreviewService } from '../preview/nuke-cad-ghost-preview-service';
import type { NukeCadSketchEditService } from '../sketch/sketch-edit-service';
import type { PreparedSketchEdit, SketchEditPrepareResult, SketchEditRequest } from '../sketch/sketch-edit-types';
import { MAX_IMPORT_SOURCE_BYTES } from './import-source-policy';
import { hashScriptContent } from './script-source-policy';
import type { NukeCadScriptAuditService } from './script-audit-service';
import * as path from 'path';

const WORKSPACE = '/workspace/project';
const DOCUMENT_PATH = `${WORKSPACE}/pincell.nuke-cad`;
const CONTEXT: NukeCapabilityContext = { workspaceRoots: [WORKSPACE], activeCadDocument: DOCUMENT_PATH };
const IMPORT_PATH = `${WORKSPACE}/gui_pincell.step`;
const PARTS_IMPORT_PATH = `${WORKSPACE}/pincell.parts/gui_pincell.step`;
const IMPORT_HASH = 'a'.repeat(64);
const IMPORT_SIZE = 4096;
const IMPORT_SOLIDS: readonly ImportSolidInfo[] = [
    { index: 1, name: 'fuel', faceCount: 6, volume: 10, bboxMin: [0, 0, 0], bboxMax: [1, 1, 1], center: [0.5, 0.5, 0.5] },
    { index: 2, name: 'clad', faceCount: 8, volume: 20, bboxMin: [0, 0, 0], bboxMax: [2, 1, 1], center: [1, 0.5, 0.5] },
    { index: 3, name: 'gap', faceCount: 4, volume: 5, bboxMin: [0, 0, 0], bboxMax: [0.5, 0.5, 0.5], center: [0.25, 0.25, 0.25] }
];
const IMPORT_INSPECTION: InspectImportSourceResult = {
    success: true,
    sourceFormat: 'step',
    sourceHash: IMPORT_HASH,
    sourceSize: IMPORT_SIZE,
    fileUnit: 'mm',
    effectiveUnit: 'mm',
    unitScaleFactor: 1,
    unitsMessage: 'The source declares millimetres.',
    solidCount: IMPORT_SOLIDS.length,
    solids: IMPORT_SOLIDS,
    warnings: []
};

const SCRIPT_PATH = `${WORKSPACE}/pincell_model.py`;
const OTHER_SCRIPT_PATH = `${WORKSPACE}/other_model.py`;
const SCRIPT_BASE_CONTENT = 'from build123d import *\nmodel = Box(1, 2, 3)\n';
const SCRIPT_PROPOSED_CONTENT = 'from build123d import *\nmodel = Box(2, 2, 2)\n';

const SCRIPT_SANDBOX_STATUS: ScriptSandboxStatus = {
    available: true,
    engine: 'bubblewrap',
    version: '0.8.0',
    userns: true,
    disableUserns: true
};

const SCRIPT_SANDBOX_RESULT: SandboxedScriptBuildResult = {
    success: true,
    solidCount: 1,
    faceCount: 6,
    triangleCount: 12,
    boundingBox: { min: [0, 0, 0], max: [2, 2, 2] },
    tessPath: `${WORKSPACE}/sandbox/model.tess.json`,
    stepPath: `${WORKSPACE}/sandbox/model.step`,
    durationMs: 250,
    exitCode: 0,
    warnings: [],
    sandbox: {
        available: true,
        engine: 'bubblewrap',
        version: '0.8.0',
        disableUserns: true,
        network: 'none',
        workspace: 'none',
        writable: ['/out'],
        limits: { timeoutSeconds: 120, memoryLimitMb: 4096, processLimit: 128, fileSizeLimitMb: 512, nofile: 1024, core: 0 }
    }
};

const MANIFEST: RegionManifestData = {
    version: 1,
    volumes: [{ selector: 'fuel' }, { selector: 'clad' }],
    surfaces: []
};

const BUILD_RESULT: GeometryBuildResult = {
    success: true,
    solidCount: 2,
    faceCount: 12,
    triangleCount: 100,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    selectorMap: { fuel: [1], clad: [2] },
    regionManifest: MANIFEST,
    featureResults: [
        { featureId: 'pad-1', status: 'built' },
        { featureId: 'fillet-1', status: 'built' }
    ]
};

/** Minimal parsed tessellation used to exercise ghost publication. */
const PARSED_TESS = {
    version: 1,
    tolerance: 0,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    solids: [],
    faces: [],
    edges: [],
    curves: []
};

const ASSEMBLY_PARSED_TESS = {
    ...PARSED_TESS,
    solids: [1, 2].map((solidId) => ({
        solidId,
        bodyId: solidId === 1 ? 'body-base' : 'body-arm',
        faceCount: 6,
        edgeCount: 12,
        triangleCount: 12
    }))
};

const OPENMC_PROJECT_PATH = `${WORKSPACE}/pincell.nuke-openmc`;
const OPENMC_CONTEXT: NukeCapabilityContext = { ...CONTEXT, activeOpenmcProject: OPENMC_PROJECT_PATH };
const OPENMC_PROJECT_JSON = JSON.stringify({
    version: 1,
    state: {
        settings: {
            dagmcFile: 'pincell.h5m',
            dagmcInfo: { materials: { plate_region: { id: 1 } } }
        },
        materials: []
    }
});

const SIDECAR_CONTENT = JSON.stringify({
    version: 1,
    volumes: [{ selector: 'plate', name: 'plate_region' }],
    surfaces: []
});

const TOPOLOGY_MANIFEST: RegionManifestData = {
    version: 1,
    volumes: [{ selector: 'plate', name: 'plate_region' }],
    surfaces: []
};

const TOPOLOGY_BUILD_BEFORE: GeometryBuildResult = {
    success: true,
    solidCount: 3,
    faceCount: 18,
    triangleCount: 36,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    selectorMap: { plate: [1, 2, 3] },
    regionManifest: TOPOLOGY_MANIFEST,
    featureResults: [
        { featureId: 'hole-1', status: 'built' },
        { featureId: 'pattern-1', status: 'built' }
    ]
};

const TOPOLOGY_BUILD_AFTER: GeometryBuildResult = {
    success: true,
    solidCount: 4,
    faceCount: 24,
    triangleCount: 48,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    selectorMap: { plate: [1, 2, 3, 4] },
    regionManifest: TOPOLOGY_MANIFEST,
    featureResults: [
        { featureId: 'hole-1', status: 'built' },
        { featureId: 'pattern-1', status: 'built' }
    ]
};

const TOPOLOGY_BUILD_CHANGED_GROUP: GeometryBuildResult = {
    ...TOPOLOGY_BUILD_AFTER,
    regionManifest: {
        version: 1,
        volumes: [{ selector: 'plate', name: 'plate_region_next' }],
        surfaces: []
    }
};

const TOPOLOGY_SOLIDS_BEFORE: readonly SolidSummary[] = [1, 2, 3].map((solidId) => ({
    solidId,
    bodyId: 'body-1',
    faceCount: 6,
    edgeCount: 12,
    triangleCount: 12
}));

const TOPOLOGY_PARSED_TESS = {
    ...PARSED_TESS,
    solids: [1, 2, 3, 4].map((solidId) => ({
        solidId,
        bodyId: 'body-1',
        faceCount: 6,
        edgeCount: 12,
        triangleCount: 12
    }))
};

const PATTERN_COUNT_CHANGE = { featureId: 'pattern-1', action: 'patternCount', count: 4 } as const;

const ASSEMBLY_MANIFEST: RegionManifestData = {
    version: 1,
    volumes: [{ selector: 'base-solid' }, { selector: 'arm-solid' }],
    surfaces: []
};

const ASSEMBLY_BUILD_BEFORE: GeometryBuildResult = {
    success: true,
    solidCount: 2,
    faceCount: 12,
    triangleCount: 24,
    boundingBox: { min: [0, 0, 0], max: [30, 10, 10] },
    selectorMap: { 'base/base-solid': [1], 'arm/arm-solid': [2] },
    regionManifest: ASSEMBLY_MANIFEST,
    featureResults: [
        { featureId: 'pad-1', status: 'built' },
        { featureId: 'pad-2', status: 'built' }
    ]
};

const ASSEMBLY_BUILD_PLACED: GeometryBuildResult = {
    ...ASSEMBLY_BUILD_BEFORE,
    boundingBox: { min: [0, 0, 0], max: [40, 10, 10] }
};

const ASSEMBLY_BUILD_REMOVED: GeometryBuildResult = {
    ...ASSEMBLY_BUILD_BEFORE,
    solidCount: 1,
    faceCount: 6,
    triangleCount: 12,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    selectorMap: { 'base/base-solid': [1] },
    regionManifest: {
        version: 1,
        volumes: [{ selector: 'base-solid' }],
        surfaces: []
    }
};

const ASSEMBLY_BUILD_ADDED: GeometryBuildResult = {
    success: true,
    solidCount: 3,
    faceCount: 18,
    triangleCount: 36,
    boundingBox: { min: [0, 0, 0], max: [40, 10, 10] },
    selectorMap: { 'base/base-solid': [1], 'arm/arm-solid': [2], 'arm2/arm-solid': [3] },
    regionManifest: ASSEMBLY_MANIFEST,
    featureResults: [
        { featureId: 'pad-1', status: 'built' },
        { featureId: 'pad-2', status: 'built' }
    ]
};

const ASSEMBLY_OPENMC_PROJECT_PATH = `${WORKSPACE}/assembly.nuke-openmc`;
const ASSEMBLY_OPENMC_CONTEXT: NukeCapabilityContext = { ...CONTEXT, activeOpenmcProject: ASSEMBLY_OPENMC_PROJECT_PATH };
const ASSEMBLY_OPENMC_PROJECT_JSON = JSON.stringify({
    version: 1,
    state: {
        settings: {
            dagmcFile: 'assembly.h5m',
            dagmcInfo: { materials: { 'arm-solid': { id: 1 }, 'base-solid': { id: 2 } } }
        },
        materials: []
    }
});

const MOVE_ARM: AssemblyChangeInput = {
    action: 'setPlacement',
    instanceId: 'arm',
    placement: { position: [30, 0, 0], orientation: [0, 0, 0, 1] }
};

const REMOVE_ARM: AssemblyChangeInput = { action: 'removeInstance', instanceId: 'arm' };

const ADD_ARM2: AssemblyChangeInput = {
    action: 'addInstance',
    id: 'arm2',
    part: 'body:body-arm',
    placement: { position: [40, 0, 0], orientation: [0, 0, 0, 1] }
};

const SKETCH: SketchDef = {
    id: 'sketch-1',
    name: 'fuel-sketch',
    datumId: 'datum-xy',
    primitives: [],
    constraints: [{ id: 'constraint-1', type: 'radius' }],
    dimensions: [{ id: 'dim-1', constraintId: 'constraint-1', kind: 'radius', targetIds: ['circle-1'], driving: true, value: 0.4 }]
};

const DRAWING_EDGE_REF: TopologyRef = {
    featureId: 'hole-1',
    kind: 'edge',
    fingerprint: { curveType: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0] }
};

const DRAWING_EDGE_REF_2: TopologyRef = {
    featureId: 'pattern-1',
    kind: 'edge',
    fingerprint: { curveType: 'line', length: 5, start: [0, 0, 0], end: [5, 0, 0] }
};

const DRAWING_ACTIONS: readonly DrawingChangeAction[] = [
    { action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' },
    { action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 0.5, showHidden: true },
    { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-1', visible: false }
];

function createDocument(): NukeCadDocument {
    return {
        version: 3,
        name: 'pincell',
        units: 'mm',
        bodies: [{ id: 'body-1', name: 'Body 1', label: 'fuel' }],
        features: [
            {
                id: 'pad-1',
                name: 'Pad',
                type: 'pad',
                body: 'body-1',
                sketchId: 'sketch-1',
                params: { length: 100, end: 'blind' },
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'fillet-1',
                name: 'Fillet',
                type: 'fillet',
                body: 'body-1',
                params: { radius: 1, edges: [{ kind: 'edge', solidId: 1, edgeId: 1 }] },
                suppressed: false,
                dependsOn: ['pad-1']
            }
        ],
        sketches: [JSON.parse(JSON.stringify(SKETCH)) as SketchDef],
        curves: [],
        datums: [],
        parameters: { fuelRadius: 0.4 },
        drawings: undefined
    } as unknown as NukeCadDocument;
}

function createDrawingDocument(): NukeCadDocument {
    return {
        ...createTopologyDocument(),
        name: 'pincell',
        drawings: [
            {
                id: 'sheet-1',
                name: 'Sheet 1',
                size: 'A4',
                orientation: 'landscape',
                views: [{ id: 'view-front', kind: 'base', orientation: 'front', scale: 1, position: [120, 120] }],
                dimensions: [
                    {
                        id: 'dim-1',
                        kind: 'distance',
                        viewId: 'view-front',
                        targets: [DRAWING_EDGE_REF, DRAWING_EDGE_REF_2],
                        value: 10
                    }
                ]
            }
        ]
    };
}

function createTopologyDocument(): NukeCadDocument {
    return {
        version: 3,
        name: 'plate',
        units: 'mm',
        bodies: [{ id: 'body-1', name: 'Plate', label: 'plate' }],
        features: [
            {
                id: 'hole-1',
                name: 'Hole 1',
                type: 'hole',
                body: 'body-1',
                params: {
                    face: {
                        featureId: 'hole-1',
                        kind: 'face',
                        fingerprint: { surfaceType: 'plane', area: 100, center: [0, 0, 0], normal: [0, 0, 1] }
                    },
                    center: [0, 0],
                    diameter: 2,
                    depth: 4
                },
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'pattern-1',
                name: 'Pattern 1',
                type: 'linearPattern',
                body: 'body-1',
                params: { source: 'hole-1', count: 3, spacing: 5, axis: 'x' },
                suppressed: false,
                dependsOn: ['hole-1']
            }
        ],
        sketches: [],
        curves: [],
        datums: [],
        parameters: {},
        drawings: undefined
    } as unknown as NukeCadDocument;
}

function createAssemblyDocument(): NukeCadDocument {
    return {
        version: 3,
        name: 'assembly',
        units: 'mm',
        bodies: [
            { id: 'body-base', name: 'Base', label: 'base-solid' },
            { id: 'body-arm', name: 'Arm', label: 'arm-solid' }
        ],
        features: [
            {
                id: 'pad-1',
                name: 'Base pad',
                type: 'pad',
                body: 'body-base',
                params: { length: 10 },
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'pad-2',
                name: 'Arm pad',
                type: 'pad',
                body: 'body-arm',
                params: { length: 10 },
                suppressed: false,
                dependsOn: []
            }
        ],
        sketches: [],
        curves: [],
        datums: [],
        parameters: {},
        assembly: {
            instances: [
                {
                    id: 'base',
                    part: 'body:body-base',
                    placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] }
                },
                {
                    id: 'arm',
                    part: 'body:body-arm',
                    placement: { position: [20, 0, 0], orientation: [0, 0, 0, 1] }
                }
            ],
            connectors: [],
            mates: [],
            groundedInstanceId: 'base'
        },
        drawings: undefined
    } as unknown as NukeCadDocument;
}

function createPreparedSketchEdit(document: NukeCadDocument): PreparedSketchEdit {
    const beforeSketch = document.sketches[0];
    const afterSketch: SketchDef = {
        ...beforeSketch,
        parameters: {},
        dimensions: (beforeSketch.dimensions ?? []).map((dimension) =>
            dimension.id === 'dim-1' ? { ...dimension, value: 0.44 } : dimension
        )
    };
    return {
        targetSketchId: 'sketch-1',
        targetSketchName: 'fuel-sketch',
        afterDocument: { ...document, sketches: [afterSketch] },
        beforeSketches: { 'sketch-1': beforeSketch },
        afterSketches: { 'sketch-1': afterSketch },
        beforeParameters: {},
        afterParameters: {},
        edits: [
            {
                kind: 'dimension',
                sketchId: 'sketch-1',
                sketchName: 'fuel-sketch',
                dimensionId: 'dim-1',
                dimensionKind: 'radius',
                before: 0.4,
                after: 0.44,
                affectedDimensionIds: ['dim-1']
            }
        ],
        changes: [
            {
                path: 'sketches.sketch-1.dimensions.dim-1',
                label: 'fuel-sketch: Radius dim-1',
                kind: 'update',
                before: 0.4,
                after: 0.44
            }
        ],
        solver: {
            status: 'converged',
            dof: 0,
            fullyConstrained: true,
            conflicting: [],
            redundant: [],
            errorCount: 0,
            warningCount: 0,
            sketches: [
                {
                    sketchId: 'sketch-1',
                    sketchName: 'fuel-sketch',
                    status: 'converged',
                    dof: 0,
                    fullyConstrained: true,
                    conflicting: [],
                    redundant: [],
                    errorCount: 0,
                    warningCount: 0
                }
            ]
        },
        affectedSketchIds: ['sketch-1'],
        affectedFeatureIds: ['pad-1']
    };
}

interface Harness {
    capabilities: NukeCadAuthoringCapabilities;
    registered: Map<string, NukeCapability>;
    proposals: NukeCadProposalService;
    edits: { id: string; params: Record<string, unknown> }[][];
    replacements: { id: string; params: Record<string, unknown> }[][];
    sketchEdits: { sketches: SketchDef[]; parameters: Record<string, number> }[];
    imports: { bodies: readonly ImportBodyDraft[]; bodyIds: string[]; featureIds: string[] }[];
    assemblyChanges: { actions: readonly AssemblyChangeInput[] }[];
    drawingChanges: { actions: readonly DrawingChangeAction[] }[];
    selections: (string | undefined)[];
    selectionClears: number;
    stateSelections: number;
    undoCalls: number;
    commands: string[];
    commandCalls: { id: string; args: readonly unknown[] }[];
    undoEntries: NukeUndoEntry[];
    fileService: {
        create: ReturnType<typeof vi.fn>;
        createFolder: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
        exists: ReturnType<typeof vi.fn>;
        move: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
        resolve: ReturnType<typeof vi.fn>;
    };
    fileDialog: { showOpenDialog: ReturnType<typeof vi.fn> };
    filesystem: Map<string, FileStat>;
    files: Map<string, string>;
    service: {
        buildDocument: ReturnType<typeof vi.fn>;
        buildSandboxedScript: ReturnType<typeof vi.fn>;
        cancelJob: ReturnType<typeof vi.fn>;
        getScriptSandboxStatus: ReturnType<typeof vi.fn>;
        inspectImportSource: ReturnType<typeof vi.fn>;
    };
    store: CadDocumentStore;
    stateManager: NukeCadStateManager;
    setStateModel: (model: CadModel | undefined) => void;
    preferences: { get: ReturnType<typeof vi.fn> };
    ghostPreview: { show: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
    sketchPrepare: ReturnType<typeof vi.fn>;
    monaco: { getTextDocument: ReturnType<typeof vi.fn> };
    scriptAudit: { record: ReturnType<typeof vi.fn> };
    scriptBuilds: SandboxedScriptBuildRequest[];
    get sandboxStatusCalls(): number;
    get auditRecords(): Record<string, unknown>[];
    bumpRevision: () => void;
    bumpEpoch: () => void;
    currentDocument: () => NukeCadDocument;
    drawingVersion: () => number;
}

interface HarnessOptions {
    enabled?: boolean;
    scriptAuthoring?: boolean;
    build?: GeometryBuildResult;
    hasModel?: boolean;
    saved?: boolean;
    document?: NukeCadDocument;
    modelResult?: GeometryBuildResult;
    solidSummaries?: readonly SolidSummary[];
    files?: Readonly<Record<string, string>>;
    filesystem?: Readonly<Record<string, Partial<FileStat>>>;
    inspection?: Partial<InspectImportSourceResult> | ((request: InspectImportSourceRequest) => Promise<InspectImportSourceResult>);
    pickImport?: string | (() => Promise<URI | undefined>);
    importAddSucceeds?: boolean;
    assemblyApplySucceeds?: boolean;
    drawingApplySucceeds?: boolean;
    prepare?: (document: NukeCadDocument, requests: readonly SketchEditRequest[]) => Promise<SketchEditPrepareResult>;
    scriptMode?: boolean;
    scriptPath?: string;
    scriptContent?: string;
    sandboxStatus?: ScriptSandboxStatus | (() => Promise<ScriptSandboxStatus>);
    sandboxBuild?: SandboxedScriptBuildResult | ((request: SandboxedScriptBuildRequest) => Promise<SandboxedScriptBuildResult>);
    monacoDirty?: boolean;
    corruptNextMove?: boolean;
}

function createHarness(overrides: HarnessOptions = {}): Harness {
    const scriptMode = overrides.scriptMode === true;
    const activeScriptPath = overrides.scriptPath ?? SCRIPT_PATH;
    let document = overrides.document ?? createDocument();
    let revision = scriptMode ? 0 : 3;
    let epoch = scriptMode ? 0 : 7;
    const edits: { id: string; params: Record<string, unknown> }[][] = [];
    const replacements: { id: string; params: Record<string, unknown> }[][] = [];
    const sketchEdits: { sketches: SketchDef[]; parameters: Record<string, number> }[] = [];
    const imports: { bodies: readonly ImportBodyDraft[]; bodyIds: string[]; featureIds: string[] }[] = [];
    const assemblyChanges: { actions: readonly AssemblyChangeInput[] }[] = [];
    const drawingChanges: { actions: readonly DrawingChangeAction[] }[] = [];
    const selections: (string | undefined)[] = [];
    let selectionClears = 0;
    let stateSelections = 0;
    let assemblyUndoDocument: NukeCadDocument | undefined;
    let drawingUndoDocument: NukeCadDocument | undefined;
    let drawingVersion = 1;
    let undoCalls = 0;
    const undoEntries: NukeUndoEntry[] = [];
    const files = new Map<string, string>();
    for (const [filePath, content] of Object.entries(overrides.files ?? {})) {
        files.set(new URI(filePath).path.toString(), content);
    }
    if (scriptMode) {
        files.set(new URI(activeScriptPath).path.toString(), overrides.scriptContent ?? SCRIPT_BASE_CONTENT);
    }
    const filesystem = new Map<string, FileStat>();
    for (const [filePath, spec] of Object.entries(overrides.filesystem ?? {})) {
        filesystem.set(new URI(filePath).path.toString(), {
            resource: new URI(filePath),
            name: '',
            isFile: false,
            isDirectory: false,
            isSymbolicLink: false,
            isReadonly: false,
            ...spec
        });
    }
    if (scriptMode && !filesystem.has(new URI(activeScriptPath).path.toString())) {
        filesystem.set(new URI(activeScriptPath).path.toString(), {
            resource: new URI(activeScriptPath),
            name: path.basename(activeScriptPath),
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
            isReadonly: false,
            size: new TextEncoder().encode(overrides.scriptContent ?? SCRIPT_BASE_CONTENT).byteLength
        });
    }
    const store = {
        get document(): NukeCadDocument | undefined {
            return scriptMode ? undefined : document;
        },
        get uri(): string | undefined {
            return scriptMode || overrides.saved === false ? undefined : new URI(DOCUMENT_PATH).toString();
        },
        get documentEpoch(): number {
            return epoch;
        },
        get revision(): number {
            return revision;
        },
        get drawingVersion(): number {
            return drawingVersion;
        },
        toJson(): string {
            return JSON.stringify(document);
        },
        updateFeatureParamsBatch(batch: readonly { id: string; params: Record<string, unknown> }[]): { success: boolean } {
            edits.push(batch.map((entry) => ({ id: entry.id, params: { ...entry.params } })));
            document = {
                ...document,
                features: document.features.map((feature) => {
                    const edit = batch.find((entry) => entry.id === feature.id);
                    return edit ? { ...feature, params: { ...feature.params, ...edit.params } } : feature;
                })
            };
            revision += 1;
            return { success: true };
        },
        replaceFeatureParamsBatch(batch: readonly { id: string; params: Record<string, unknown> }[]): { success: boolean } {
            replacements.push(
                batch.map((entry) => ({ id: entry.id, params: JSON.parse(JSON.stringify(entry.params)) as Record<string, unknown> }))
            );
            document = {
                ...document,
                features: document.features.map((feature) => {
                    const replacement = batch.find((entry) => entry.id === feature.id);
                    return replacement ? { ...feature, params: { ...replacement.params } } : feature;
                })
            };
            revision += 1;
            return { success: true };
        },
        applySketchAuthoringEdit(edit: { sketches: readonly SketchDef[]; parameters?: Readonly<Record<string, number>> }): {
            success: boolean;
        } {
            const sketches = edit.sketches.map((sketch) => JSON.parse(JSON.stringify(sketch)) as SketchDef);
            const parameters = { ...(edit.parameters ?? {}) };
            for (const sketch of sketches) {
                Object.assign(parameters, sketch.parameters ?? {});
            }
            sketchEdits.push({ sketches, parameters });
            document = {
                ...document,
                sketches: document.sketches.map((sketch) => {
                    const replacement = sketches.find((entry) => entry.id === sketch.id);
                    return replacement ? { ...replacement, parameters: undefined } : sketch;
                }),
                parameters: { ...document.parameters, ...parameters }
            };
            revision += 1;
            return { success: true };
        },
        addImportBodies(request: ImportBodiesRequest): {
            success: boolean;
            value?: { bodyIds: string[]; featureIds: string[] };
            error?: string;
        } {
            if (overrides.importAddSucceeds === false) {
                return { success: false, error: 'The CAD document rejected the import.' };
            }
            const batch = imports.length + 1;
            const bodyIds = request.bodies.map((_, index) => `import-body-${batch}-${index + 1}`);
            const featureIds = request.bodies.map((_, index) => `import-feature-${batch}-${index + 1}`);
            const bodies = request.bodies.map((draft, index) => ({
                id: bodyIds[index],
                name: draft.name,
                ...(draft.label !== undefined ? { label: draft.label } : {}),
                ...(draft.material !== undefined ? { material: draft.material } : {})
            }));
            const features = request.bodies.map((draft, index) => ({
                id: featureIds[index],
                name: draft.name,
                type: 'import' as const,
                body: bodyIds[index],
                params: JSON.parse(JSON.stringify(draft.params)) as Record<string, unknown>,
                suppressed: false,
                dependsOn: []
            }));
            imports.push({
                bodies: request.bodies.map((draft) => JSON.parse(JSON.stringify(draft)) as ImportBodyDraft),
                bodyIds,
                featureIds
            });
            document = {
                ...document,
                bodies: [...document.bodies, ...bodies],
                features: [...document.features, ...features]
            };
            revision += 1;
            return { success: true, value: { bodyIds, featureIds } };
        },
        applyAssemblyChanges(request: { actions: readonly AssemblyChangeInput[] }): {
            success: boolean;
            value?: { instanceIds: readonly string[]; removedInstanceIds: readonly string[]; groundedInstanceId: string };
            error?: string;
        } {
            if (overrides.assemblyApplySucceeds === false) {
                return { success: false, error: 'The CAD document rejected the assembly change.' };
            }
            const assembly = document.assembly;
            if (assembly === undefined) {
                return { success: false, error: 'No assembly section' };
            }
            const actions = JSON.parse(JSON.stringify(request.actions)) as AssemblyChangeInput[];
            assemblyChanges.push({ actions });
            const previous = document;
            const addedInstanceIds: string[] = [];
            const removedInstanceIds: string[] = [];
            let instances = assembly.instances.map(
                (instance) => JSON.parse(JSON.stringify(instance)) as (typeof assembly.instances)[number]
            );
            for (const action of actions) {
                if (action.action === 'addInstance') {
                    const id = action.id ?? `instance-${instances.length + 1}`;
                    addedInstanceIds.push(id);
                    instances.push({
                        id,
                        part: action.part,
                        placement: action.placement,
                        ...(action.scale !== undefined ? { scale: action.scale } : {})
                    });
                } else if (action.action === 'removeInstance') {
                    removedInstanceIds.push(action.instanceId);
                    instances = instances.filter((instance) => instance.id !== action.instanceId);
                } else {
                    instances = instances.map((instance) =>
                        instance.id === action.instanceId ? { ...instance, placement: action.placement } : instance
                    );
                }
            }
            document = {
                ...document,
                assembly: { ...assembly, instances }
            };
            assemblyUndoDocument = previous;
            revision += 1;
            return {
                success: true,
                value: { instanceIds: addedInstanceIds, removedInstanceIds, groundedInstanceId: assembly.groundedInstanceId }
            };
        },
        applyDrawingChanges(request: { actions: readonly DrawingChangeAction[] }): {
            success: boolean;
            value?: { sheetId: string; viewCount: number; dimensionCount: number; drawingVersion: number };
            error?: string;
        } {
            if (overrides.drawingApplySucceeds === false) {
                return { success: false, error: 'The CAD document rejected the drawing change.' };
            }
            const actions = JSON.parse(JSON.stringify(request.actions)) as DrawingChangeAction[];
            drawingChanges.push({ actions });
            const sheetId = actions[0]?.sheetId;
            const draft = JSON.parse(JSON.stringify(document)) as NukeCadDocument;
            const sheet = (draft.drawings ?? []).find((candidate) => candidate.id === sheetId);
            if (sheet === undefined) {
                return { success: false, error: `Drawing sheet '${String(sheetId)}' not found` };
            }
            for (const action of actions) {
                if (action.action === 'setSheetSize') {
                    sheet.size = action.size;
                } else if (action.action === 'setViewDisplay') {
                    const view = sheet.views.find((candidate) => candidate.id === action.viewId);
                    if (view !== undefined) {
                        if (action.scale !== undefined) {
                            view.scale = action.scale;
                        }
                        if (action.showHidden !== undefined) {
                            view.showHidden = action.showHidden;
                        }
                    }
                } else {
                    const dimension = sheet.dimensions.find((candidate) => candidate.id === action.dimensionId);
                    if (dimension !== undefined) {
                        dimension.hidden = !action.visible;
                    }
                }
            }
            drawingUndoDocument = document;
            document = draft;
            revision += 1;
            drawingVersion += 1;
            return {
                success: true,
                value: {
                    sheetId: sheet.id,
                    viewCount: sheet.views.length,
                    dimensionCount: sheet.dimensions.length,
                    drawingVersion
                }
            };
        },
        undo(): { success: boolean; error?: string } {
            undoCalls += 1;
            if (drawingUndoDocument !== undefined) {
                document = drawingUndoDocument;
                drawingUndoDocument = undefined;
                drawingVersion += 1;
                revision += 1;
                return { success: true };
            }
            if (assemblyUndoDocument !== undefined) {
                document = assemblyUndoDocument;
                assemblyUndoDocument = undefined;
                revision += 1;
                return { success: true };
            }
            const last = imports.pop();
            if (last === undefined) {
                return { success: false, error: 'Nothing to undo' };
            }
            document = {
                ...document,
                bodies: document.bodies.filter((body) => !last.bodyIds.includes(body.id)),
                features: document.features.filter((feature) => !last.featureIds.includes(feature.id))
            };
            revision += 1;
            return { success: true };
        },
        selectBody(id: string | undefined): void {
            selections.push(id);
        },
        clearSelection(): void {
            selectionClears += 1;
        }
    } as unknown as CadDocumentStore;
    let stateModel: CadModel | undefined =
        overrides.hasModel === false
            ? undefined
            : scriptMode
              ? ({
                    scriptPath: activeScriptPath,
                    result: overrides.modelResult ?? BUILD_RESULT,
                    manifest: (overrides.modelResult ?? BUILD_RESULT).regionManifest
                } as CadModel)
              : ({
                    scriptPath: DOCUMENT_PATH,
                    result: overrides.modelResult ?? BUILD_RESULT,
                    manifest: (overrides.modelResult ?? BUILD_RESULT).regionManifest
                } as CadModel);
    const setStateModel = vi.fn((next: CadModel | undefined) => {
        stateModel = next;
    });
    const stateManager = {
        get model(): CadModel | undefined {
            return stateModel;
        },
        get scriptPath(): string | undefined {
            return stateModel?.scriptPath;
        },
        solidSummaries: overrides.solidSummaries ?? [],
        setModel: setStateModel,
        setSelection: vi.fn(() => {
            stateSelections += 1;
        })
    } as unknown as NukeCadStateManager;
    const scriptBuilds: SandboxedScriptBuildRequest[] = [];
    let sandboxStatusCalls = 0;
    const service = {
        buildDocument: vi.fn(async () => overrides.build ?? BUILD_RESULT),
        getScriptSandboxStatus: vi.fn(async (): Promise<ScriptSandboxStatus> => {
            sandboxStatusCalls += 1;
            if (typeof overrides.sandboxStatus === 'function') {
                return overrides.sandboxStatus();
            }
            return overrides.sandboxStatus ?? SCRIPT_SANDBOX_STATUS;
        }),
        buildSandboxedScript: vi.fn(async (request: SandboxedScriptBuildRequest): Promise<SandboxedScriptBuildResult> => {
            scriptBuilds.push(request);
            if (typeof overrides.sandboxBuild === 'function') {
                return overrides.sandboxBuild(request);
            }
            return overrides.sandboxBuild ?? SCRIPT_SANDBOX_RESULT;
        }),
        cancelJob: vi.fn(async () => true),
        inspectImportSource: vi.fn(async (request: InspectImportSourceRequest): Promise<InspectImportSourceResult> => {
            if (typeof overrides.inspection === 'function') {
                return overrides.inspection(request);
            }
            return {
                ...IMPORT_INSPECTION,
                sourcePath: request.sourcePath,
                ...(request.sourceUnit !== undefined ? { effectiveUnit: request.sourceUnit } : {}),
                ...(overrides.inspection ?? {})
            };
        })
    };
    const fileService = {
        create: vi.fn(async (uri: URI, content: string) => {
            const filePath = uri.path.toString();
            files.set(filePath, content);
            filesystem.set(filePath, {
                resource: uri,
                name: path.basename(filePath),
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                isReadonly: false,
                size: new TextEncoder().encode(content).byteLength
            });
        }),
        createFolder: vi.fn(async () => undefined),
        delete: vi.fn(async (uri: URI, options?: { recursive?: boolean }) => {
            const target = uri.path.toString();
            for (const key of [...files.keys()]) {
                if (key === target || (options?.recursive === true && key.startsWith(`${target}/`))) {
                    files.delete(key);
                }
            }
            for (const key of [...filesystem.keys()]) {
                if (key === target || (options?.recursive === true && key.startsWith(`${target}/`))) {
                    filesystem.delete(key);
                }
            }
        }),
        exists: vi.fn(async (uri: URI) => files.has(uri.path.toString())),
        move: vi.fn(async (source: URI, target: URI) => {
            const sourcePath = source.path.toString();
            const targetPath = target.path.toString();
            const content = files.get(sourcePath);
            if (content === undefined) {
                throw new Error(`File not found: ${sourcePath}`);
            }
            const written = overrides.corruptNextMove === true ? 'corrupted write' : content;
            if (overrides.corruptNextMove === true) {
                overrides.corruptNextMove = false;
            }
            files.set(targetPath, written);
            files.delete(sourcePath);
            filesystem.delete(sourcePath);
            filesystem.set(targetPath, {
                resource: target,
                name: path.basename(targetPath),
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                isReadonly: false,
                size: new TextEncoder().encode(written).byteLength
            });
        }),
        readFile: vi.fn(async (uri: URI) => {
            const content = files.get(uri.path.toString());
            if (content === undefined) {
                throw new Error(`File not found: ${uri.path.toString()}`);
            }
            return { value: { toString: () => content, buffer: new TextEncoder().encode(content).buffer } };
        }),
        resolve: vi.fn(async (uri: URI) => {
            const stat = filesystem.get(uri.path.toString());
            if (stat === undefined) {
                throw new Error(`File not found: ${uri.path.toString()}`);
            }
            return stat;
        })
    };
    const fileDialog = {
        showOpenDialog: vi.fn(async () => {
            if (typeof overrides.pickImport === 'function') {
                return overrides.pickImport();
            }
            return overrides.pickImport === undefined ? undefined : new URI(overrides.pickImport);
        })
    };
    const preferences = {
        get: vi.fn((key: string) => {
            if (key === SCRIPT_AUTHORING_PREFERENCE) {
                return overrides.scriptAuthoring ?? true;
            }
            return overrides.enabled ?? true;
        })
    };
    const commands: string[] = [];
    const commandCalls: { id: string; args: readonly unknown[] }[] = [];
    const commandService = {
        executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
            commands.push(id);
            commandCalls.push({ id, args });
        })
    } as unknown as Pick<CommandService, 'executeCommand'>;
    const undoService = {
        register: vi.fn((entry: NukeUndoEntry) => {
            undoEntries.push(entry);
            return 'undo-token-1';
        }),
        has: vi.fn(() => true),
        undo: vi.fn(async () => ({ ok: true }))
    } as unknown as NukeUndoService;
    const ghostPreview = {
        show: vi.fn(),
        clear: vi.fn(),
        state: undefined,
        onDidChange: vi.fn()
    };
    const proposals = new NukeCadProposalService();
    const sketchPrepare = vi.fn(
        overrides.prepare ??
            (async (doc: NukeCadDocument): Promise<SketchEditPrepareResult> => ({ ok: true, result: createPreparedSketchEdit(doc) }))
    );
    const sketchEditService = { prepare: sketchPrepare } as unknown as NukeCadSketchEditService;
    const monaco = {
        getTextDocument: vi.fn((_uri: string) => (overrides.monacoDirty === undefined ? undefined : { dirty: overrides.monacoDirty }))
    };
    const auditRecords: Record<string, unknown>[] = [];
    const scriptAudit = {
        record: vi.fn(async (entry: Record<string, unknown>) => {
            auditRecords.push(entry);
        })
    };
    const capabilities = new NukeCadAuthoringCapabilities(
        stateManager,
        service as unknown as NukeCadFrontendService,
        store,
        proposals,
        fileService as unknown as FileService,
        fileDialog as unknown as FileDialogService,
        preferences as unknown as NukeCadPreferences,
        commandService as unknown as CommandService,
        undoService,
        ghostPreview as unknown as NukeCadGhostPreviewService,
        sketchEditService,
        monaco as unknown as MonacoWorkspace,
        {} as never,
        {} as never
    );
    (capabilities as unknown as { scriptAudit: NukeCadScriptAuditService }).scriptAudit =
        scriptAudit as unknown as NukeCadScriptAuditService;
    const registered = new Map<string, NukeCapability>();
    capabilities.registerCapabilities({
        register: (capability: NukeCapability) => registered.set(capability.id, capability)
    } as unknown as NukeCapabilityRegistry);
    return {
        capabilities,
        registered,
        proposals,
        edits,
        replacements,
        sketchEdits,
        imports,
        assemblyChanges,
        drawingChanges,
        selections,
        get selectionClears(): number {
            return selectionClears;
        },
        get stateSelections(): number {
            return stateSelections;
        },
        get undoCalls(): number {
            return undoCalls;
        },
        commands,
        commandCalls,
        undoEntries,
        fileService,
        fileDialog,
        filesystem,
        files,
        service,
        store,
        stateManager,
        setStateModel,
        preferences,
        ghostPreview,
        sketchPrepare,
        monaco,
        scriptAudit,
        scriptBuilds,
        get sandboxStatusCalls(): number {
            return sandboxStatusCalls;
        },
        get auditRecords(): Record<string, unknown>[] {
            return auditRecords;
        },
        bumpRevision: () => {
            revision += 1;
        },
        bumpEpoch: () => {
            epoch += 1;
        },
        currentDocument: () => document,
        drawingVersion: () => drawingVersion
    };
}

async function preview(harness: Harness): Promise<NukeCapabilityResult> {
    return harness.registered
        .get(PREVIEW_FEATURE_CHANGE_ID)!
        .invoke({ changes: [{ featureId: 'pad-1', param: 'length', value: 120 }] }, CONTEXT);
}

function apply(harness: Harness, proposalId: string): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_FEATURE_CHANGE_ID)!.invoke({ proposalId }, CONTEXT);
}

const SKETCH_REQUEST: readonly SketchEditRequest[] = [{ sketchId: 'sketch-1', dimensionId: 'dim-1', value: 0.44 }];

function previewSketch(harness: Harness, input: unknown = { changes: SKETCH_REQUEST }): Promise<NukeCapabilityResult> {
    return harness.registered.get(PREVIEW_SKETCH_CHANGE_ID)!.invoke(input, CONTEXT);
}

function applySketch(harness: Harness, proposalId: string): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_SKETCH_CHANGE_ID)!.invoke({ proposalId }, CONTEXT);
}

async function previewedSketchProposal(harness: Harness): Promise<string> {
    const result = await previewSketch(harness);
    expect(result.ok).toBe(true);
    return (result.data as { proposalId: string }).proposalId;
}

function topologyHarness(overrides: HarnessOptions = {}): Harness {
    return createHarness({
        document: createTopologyDocument(),
        modelResult: TOPOLOGY_BUILD_BEFORE,
        build: TOPOLOGY_BUILD_AFTER,
        solidSummaries: TOPOLOGY_SOLIDS_BEFORE,
        ...overrides
    });
}

function previewTopology(
    harness: Harness,
    input: unknown = { changes: [PATTERN_COUNT_CHANGE] },
    context: NukeCapabilityContext = CONTEXT
): Promise<NukeCapabilityResult> {
    return harness.registered.get(PREVIEW_TOPOLOGY_CHANGE_ID)!.invoke(input, context);
}

function applyTopology(
    harness: Harness,
    proposalId: string,
    context: NukeCapabilityContext = CONTEXT,
    acknowledgeRegionChanges = true
): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_TOPOLOGY_CHANGE_ID)!.invoke({ proposalId, acknowledgeRegionChanges }, context);
}

async function previewedTopologyProposal(harness: Harness, context: NukeCapabilityContext = CONTEXT): Promise<string> {
    const result = await previewTopology(harness, { changes: [PATTERN_COUNT_CHANGE] }, context);
    expect(result.ok).toBe(true);
    return (result.data as { proposalId: string }).proposalId;
}

function stubCandidateTessellation(harness: Harness): void {
    vi.spyOn(
        harness.capabilities as unknown as { readCandidateTessellation: () => Promise<typeof TOPOLOGY_PARSED_TESS> },
        'readCandidateTessellation'
    ).mockResolvedValue(TOPOLOGY_PARSED_TESS);
}

function assemblyHarness(overrides: HarnessOptions = {}): Harness {
    return createHarness({
        document: createAssemblyDocument(),
        modelResult: ASSEMBLY_BUILD_BEFORE,
        build: ASSEMBLY_BUILD_PLACED,
        solidSummaries: [1, 2].map((solidId) => ({
            solidId,
            faceCount: 6,
            edgeCount: 12,
            triangleCount: 12
        })),
        ...overrides
    });
}

function summarizeAssembly(harness: Harness, context: NukeCapabilityContext = CONTEXT): Promise<NukeCapabilityResult> {
    return harness.registered.get(SUMMARIZE_ASSEMBLY_ID)!.invoke({}, context);
}

function previewAssembly(
    harness: Harness,
    input: unknown = { changes: [MOVE_ARM] },
    context: NukeCapabilityContext = CONTEXT
): Promise<NukeCapabilityResult> {
    return harness.registered.get(PREVIEW_ASSEMBLY_CHANGE_ID)!.invoke(input, context);
}

function applyAssembly(
    harness: Harness,
    proposalId: string,
    context: NukeCapabilityContext = CONTEXT,
    acknowledgeRegionChanges = false
): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_ASSEMBLY_CHANGE_ID)!.invoke({ proposalId, acknowledgeRegionChanges }, context);
}

async function previewedAssemblyProposal(
    harness: Harness,
    input: unknown = { changes: [MOVE_ARM] },
    context: NukeCapabilityContext = CONTEXT
): Promise<string> {
    const result = await previewAssembly(harness, input, context);
    expect(result.ok).toBe(true);
    return (result.data as { proposalId: string }).proposalId;
}

function stubAssemblyTessellation(harness: Harness): void {
    vi.spyOn(
        harness.capabilities as unknown as { readCandidateTessellation: () => Promise<typeof ASSEMBLY_PARSED_TESS> },
        'readCandidateTessellation'
    ).mockResolvedValue(ASSEMBLY_PARSED_TESS);
}

function drawingHarness(overrides: HarnessOptions = {}): Harness {
    return createHarness({ document: createDrawingDocument(), ...overrides });
}

function summarizeDrawing(harness: Harness): Promise<NukeCapabilityResult> {
    return harness.registered.get(SUMMARIZE_DRAWING_ID)!.invoke({}, CONTEXT);
}

function previewDrawing(
    harness: Harness,
    input: unknown = { changes: DRAWING_ACTIONS },
    context: NukeCapabilityContext = CONTEXT
): Promise<NukeCapabilityResult> {
    return harness.registered.get(PREVIEW_DRAWING_CHANGE_ID)!.invoke(input, context);
}

function applyDrawing(harness: Harness, proposalId: string, context: NukeCapabilityContext = CONTEXT): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_DRAWING_CHANGE_ID)!.invoke({ proposalId }, context);
}

async function previewedDrawingProposal(
    harness: Harness,
    input: unknown = { changes: DRAWING_ACTIONS },
    context: NukeCapabilityContext = CONTEXT
): Promise<string> {
    const result = await previewDrawing(harness, input, context);
    expect(result.ok).toBe(true);
    return (result.data as { proposalId: string }).proposalId;
}

function importHarness(overrides: HarnessOptions = {}): Harness {
    return createHarness({
        pickImport: IMPORT_PATH,
        ...overrides,
        filesystem: {
            [IMPORT_PATH]: { isFile: true, size: IMPORT_SIZE },
            [`${WORKSPACE}/pincell.parts`]: { isDirectory: true },
            [PARTS_IMPORT_PATH]: { isFile: true, size: IMPORT_SIZE },
            ...overrides.filesystem
        }
    });
}

function inspectImport(
    harness: Harness,
    input: unknown = { sourcePath: IMPORT_PATH },
    context: NukeCapabilityContext = CONTEXT
): Promise<NukeCapabilityResult> {
    return harness.registered.get(INSPECT_IMPORT_SOURCE_ID)!.invoke(input, context);
}

const IMPORT_PREVIEW_INPUT = {
    sourcePath: IMPORT_PATH,
    strategy: 'perSolid',
    label: 'gui_pincell',
    solidIndexes: [1, 2]
} as const;

function previewImport(
    harness: Harness,
    input: unknown = IMPORT_PREVIEW_INPUT,
    context: NukeCapabilityContext = CONTEXT
): Promise<NukeCapabilityResult> {
    return harness.registered.get(PREVIEW_IMPORT_BODIES_ID)!.invoke(input, context);
}

function applyImport(harness: Harness, proposalId: string, context: NukeCapabilityContext = CONTEXT): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_IMPORT_BODIES_ID)!.invoke({ proposalId }, context);
}

async function previewedImportProposal(
    harness: Harness,
    input: unknown = IMPORT_PREVIEW_INPUT,
    context: NukeCapabilityContext = CONTEXT,
    sourcePath = IMPORT_PATH
): Promise<string> {
    const inspected = await inspectImport(harness, { sourcePath }, context);
    expect(inspected.ok).toBe(true);
    const result = await previewImport(harness, input, context);
    expect(result.ok).toBe(true);
    return (result.data as { proposalId: string }).proposalId;
}

async function authorizeImport(harness: Harness, sourcePath = IMPORT_PATH): Promise<void> {
    const inspected = await inspectImport(harness, { sourcePath });
    expect(inspected.ok).toBe(true);
}

const SCRIPT_CONTEXT: NukeCapabilityContext = { ...CONTEXT, activeCadDocument: SCRIPT_PATH };

function scriptHarness(overrides: HarnessOptions = {}): Harness {
    return createHarness({ scriptMode: true, ...overrides });
}

function inspectScript(harness: Harness, context: NukeCapabilityContext = SCRIPT_CONTEXT): Promise<NukeCapabilityResult> {
    return harness.registered.get(INSPECT_SCRIPT_SOURCE_ID)!.invoke({}, context);
}

async function scriptPreviewInput(overrides: { proposedScript?: string; baseScriptHash?: string; summary?: string } = {}): Promise<{
    baseScriptHash: string;
    proposedScript: string;
    summary?: string;
}> {
    return {
        baseScriptHash: overrides.baseScriptHash ?? (await hashScriptContent(SCRIPT_BASE_CONTENT)),
        proposedScript: overrides.proposedScript ?? SCRIPT_PROPOSED_CONTENT,
        ...(overrides.summary !== undefined ? { summary: overrides.summary } : {})
    };
}

function previewScript(harness: Harness, input: unknown, context: NukeCapabilityContext = SCRIPT_CONTEXT): Promise<NukeCapabilityResult> {
    return harness.registered.get(PREVIEW_SCRIPT_CHANGE_ID)!.invoke(input, context);
}

function applyScript(
    harness: Harness,
    proposalId: string,
    approvalId: string,
    context: NukeCapabilityContext = SCRIPT_CONTEXT
): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_SCRIPT_CHANGE_ID)!.invoke({ proposalId, approvalId }, context);
}

function scriptProposal(harness: Harness, proposalId: string): NukeCadScriptProposal {
    const proposal = harness.proposals.get(proposalId);
    if (proposal === undefined || !isScriptProposal(proposal)) {
        throw new Error('Expected a script proposal');
    }
    return proposal;
}

async function previewedScript(harness: Harness): Promise<{ proposalId: string; approvalId: string }> {
    const result = await previewScript(harness, await scriptPreviewInput());
    expect(result.ok).toBe(true);
    const proposalId = (result.data as { proposalId: string }).proposalId;
    return { proposalId, approvalId: scriptProposal(harness, proposalId).script.approvalId };
}

describe('readFeatureParamChanges', () => {
    it('accepts the expanded topology-preserving parameter set', () => {
        const result = readFeatureParamChanges({
            changes: [
                { featureId: 'chamfer1', param: 'distance', value: 1.5 },
                { featureId: 'draft1', param: 'angle', value: 5 },
                { featureId: 'pattern1', param: 'spacing', value: -4 },
                { featureId: 'pattern2', param: 'angle', value: 180 },
                { featureId: 'hole1', param: 'diameter', value: 2.5 },
                { featureId: 'hole1', param: 'depth', value: 3 }
            ]
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.changes).toHaveLength(6);
        }
    });

    it('rejects an unknown parameter', () => {
        const result = readFeatureParamChanges({ changes: [{ featureId: 'pad1', param: 'width', value: 2 }] });
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Unsupported') });
    });
});

describe('readSketchEditRequests', () => {
    it('accepts exactly one dimension or parameter target per edit', () => {
        const result = readSketchEditRequests({
            changes: [
                { sketchId: 'sketch-1', dimensionId: 'dim-1', value: 0.44 },
                { sketchId: 'sketch-1', parameterName: 'fuelRadius', value: 0.5 }
            ]
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.changes).toEqual([
                { sketchId: 'sketch-1', dimensionId: 'dim-1', value: 0.44 },
                { sketchId: 'sketch-1', parameterName: 'fuelRadius', value: 0.5 }
            ]);
        }
    });

    it('rejects ambiguous, empty, and non-finite edits', () => {
        expect(
            readSketchEditRequests({
                changes: [{ sketchId: 'sketch-1', dimensionId: 'dim-1', parameterName: 'fuelRadius', value: 0.44 }]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('exactly one') });
        expect(readSketchEditRequests({ changes: [{ sketchId: 'sketch-1', value: 0.44 }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('exactly one')
        });
        expect(readSketchEditRequests({ changes: [{ sketchId: '', dimensionId: 'dim-1', value: 0.44 }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('sketchId')
        });
        expect(readSketchEditRequests({ changes: [{ sketchId: 'sketch-1', dimensionId: 'dim-1', value: Number.NaN }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('finite')
        });
        const tooMany = Array.from({ length: 9 }, (_, index) => ({ sketchId: 'sketch-1', dimensionId: `dim-${index}`, value: 1 }));
        expect(readSketchEditRequests({ changes: tooMany })).toMatchObject({
            ok: false,
            message: expect.stringContaining('at most 8')
        });
    });
});

describe('readTopologyActions', () => {
    it('accepts hole depth modes and pattern counts', () => {
        const result = readTopologyActions({
            changes: [
                { featureId: 'hole-1', action: 'holeDepthMode', mode: 'through' },
                { featureId: 'hole-2', action: 'holeDepthMode', mode: 'blind', depth: 4 },
                { featureId: 'pattern-1', action: 'patternCount', count: 4 }
            ]
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.actions).toEqual([
                { featureId: 'hole-1', action: 'holeDepthMode', mode: 'through' },
                { featureId: 'hole-2', action: 'holeDepthMode', mode: 'blind', depth: 4 },
                { featureId: 'pattern-1', action: 'patternCount', count: 4 }
            ]);
        }
    });

    it('rejects missing, contradictory, and non-numeric fields', () => {
        expect(readTopologyActions({ changes: [{ featureId: 'hole-1', action: 'holeDepthMode' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('mode')
        });
        expect(readTopologyActions({ changes: [{ featureId: 'hole-1', action: 'holeDepthMode', mode: 'blind' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('depth')
        });
        expect(
            readTopologyActions({ changes: [{ featureId: 'hole-1', action: 'holeDepthMode', mode: 'through', depth: 4 }] })
        ).toMatchObject({ ok: false, message: expect.stringContaining('cannot set depth') });
        expect(
            readTopologyActions({
                changes: [{ featureId: 'hole-1', action: 'holeDepthMode', mode: 'blind', depth: 4, count: 3 }]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('cannot set count') });
        expect(readTopologyActions({ changes: [{ featureId: 'pattern-1', action: 'patternCount', count: 4, depth: 4 }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('mode or depth')
        });
        expect(readTopologyActions({ changes: [{ featureId: '', action: 'patternCount', count: 4 }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('featureId')
        });
    });

    it('rejects duplicates, too many edits, bad counts, and unknown actions', () => {
        expect(
            readTopologyActions({
                changes: [
                    { featureId: 'pattern-1', action: 'patternCount', count: 4 },
                    { featureId: 'pattern-1', action: 'patternCount', count: 5 }
                ]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('Duplicate') });
        const tooMany = Array.from({ length: 9 }, (_, index) => ({
            featureId: `pattern-${index}`,
            action: 'patternCount',
            count: 2
        }));
        expect(readTopologyActions({ changes: tooMany })).toMatchObject({
            ok: false,
            message: expect.stringContaining('at most 8')
        });
        for (const count of [0, 1.5, 1001]) {
            expect(readTopologyActions({ changes: [{ featureId: 'pattern-1', action: 'patternCount', count }] })).toMatchObject({
                ok: false,
                message: expect.stringMatching(/at least 1|at most 1000/)
            });
        }
        expect(readTopologyActions({ changes: [{ featureId: 'pad-1', action: 'suppress' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('unknown action')
        });
    });
});

describe('readAssemblyActions', () => {
    it('accepts add, remove, and placement actions with placement and scale', () => {
        const result = readAssemblyActions({
            changes: [
                ADD_ARM2,
                REMOVE_ARM,
                { action: 'setPlacement', instanceId: 'base', placement: { position: [1, 0, 0], orientation: [0, 0, 0, 1] } },
                {
                    action: 'addInstance',
                    part: 'body:body-arm',
                    placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
                    scale: [1, 2, 3]
                }
            ]
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.actions).toEqual([
                ADD_ARM2,
                REMOVE_ARM,
                { action: 'setPlacement', instanceId: 'base', placement: { position: [1, 0, 0], orientation: [0, 0, 0, 1] } },
                {
                    action: 'addInstance',
                    part: 'body:body-arm',
                    placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
                    scale: [1, 2, 3]
                }
            ]);
        }
    });

    it('rejects empty, too many, duplicate, and malformed actions', () => {
        expect(readAssemblyActions(null)).toMatchObject({ ok: false });
        expect(readAssemblyActions({ changes: [] })).toMatchObject({ ok: false, message: expect.stringContaining('1 to 16') });
        const tooMany = Array.from({ length: 17 }, (_, index) => ({
            action: 'setPlacement',
            instanceId: `instance-${index}`,
            placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] }
        }));
        expect(readAssemblyActions({ changes: tooMany })).toMatchObject({ ok: false, message: expect.stringContaining('at most 16') });
        expect(readAssemblyActions({ changes: [MOVE_ARM, MOVE_ARM] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('Duplicate')
        });
        expect(readAssemblyActions({ changes: [{ action: 'explode', instanceId: 'arm' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('unknown action')
        });
        expect(readAssemblyActions({ changes: [{ action: 'removeInstance', instanceId: '' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('instanceId')
        });
        expect(
            readAssemblyActions({
                changes: [{ action: 'setPlacement', instanceId: 'arm', placement: { position: [0, 0], orientation: [0, 0, 0, 1] } }]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('placement') });
        expect(
            readAssemblyActions({
                changes: [
                    {
                        action: 'addInstance',
                        part: 'body:body-arm',
                        placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
                        scale: 0
                    }
                ]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('scale') });
        expect(
            readAssemblyActions({ changes: [{ action: 'removeInstance', instanceId: 'arm', placement: { position: [0, 0, 0] } }] })
        ).toMatchObject({ ok: false, message: expect.stringContaining('unknown field') });
    });
});

describe('readDrawingChangeActions', () => {
    it('accepts sheet size, view display, and dimension visibility actions', () => {
        const result = readDrawingChangeActions({ changes: DRAWING_ACTIONS });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.actions).toEqual(DRAWING_ACTIONS);
        }
    });

    it('rejects empty, too many, unknown, and malformed drawing actions', () => {
        expect(readDrawingChangeActions(null)).toMatchObject({ ok: false });
        expect(readDrawingChangeActions({ changes: [] })).toMatchObject({ ok: false, message: expect.stringContaining('1 to 16') });
        const tooMany = Array.from({ length: 17 }, () => ({ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' }));
        expect(readDrawingChangeActions({ changes: tooMany })).toMatchObject({
            ok: false,
            message: expect.stringContaining('at most 16')
        });
        expect(readDrawingChangeActions({ changes: [{ action: 'explode', sheetId: 'sheet-1' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('unknown action')
        });
        expect(readDrawingChangeActions({ changes: [{ action: 'setSheetSize', sheetId: '', size: 'A3' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('sheetId')
        });
        expect(readDrawingChangeActions({ changes: [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A2' }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining("sheet size must be 'A4' or 'A3'")
        });
        expect(
            readDrawingChangeActions({ changes: [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3', viewId: 'view-front' }] })
        ).toMatchObject({ ok: false, message: expect.stringContaining('unknown field') });
        expect(
            readDrawingChangeActions({ changes: [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front' }] })
        ).toMatchObject({ ok: false, message: expect.stringContaining('scale or showHidden') });
        expect(
            readDrawingChangeActions({ changes: [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 0 }] })
        ).toMatchObject({ ok: false, message: expect.stringContaining('positive finite') });
        expect(
            readDrawingChangeActions({
                changes: [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', showHidden: 'yes' }]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('showHidden must be a boolean') });
        expect(
            readDrawingChangeActions({
                changes: [{ action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-1', visible: 'no' }]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('visible must be a boolean') });
        expect(
            readDrawingChangeActions({
                changes: [{ action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-1', visible: false, scale: 1 }]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('unknown field') });
    });
});

describe('readInspectImportSourceInput', () => {
    it('accepts an optional absolute path and source-unit override', () => {
        expect(readInspectImportSourceInput({})).toEqual({ ok: true });
        expect(readInspectImportSourceInput({ sourcePath: IMPORT_PATH, sourceUnit: 'cm' })).toEqual({
            ok: true,
            sourcePath: IMPORT_PATH,
            sourceUnit: 'cm'
        });
    });

    it('rejects non-object, empty, and unknown-unit input', () => {
        expect(readInspectImportSourceInput('path')).toMatchObject({ ok: false });
        expect(readInspectImportSourceInput({ sourcePath: '' })).toMatchObject({ ok: false });
        expect(readInspectImportSourceInput({ sourceUnit: 'in' })).toMatchObject({
            ok: false,
            message: expect.stringContaining('sourceUnit')
        });
    });
});

describe('readImportPreviewInput', () => {
    it('accepts both strategies, indexes, units, and a material', () => {
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, sourceUnit: 'm', material: 'steel' })).toEqual({
            ok: true,
            sourcePath: IMPORT_PATH,
            strategy: 'perSolid',
            label: 'gui_pincell',
            solidIndexes: [1, 2],
            sourceUnit: 'm',
            material: 'steel'
        });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, strategy: 'single' })).toMatchObject({ ok: true, strategy: 'single' });
    });

    it('rejects missing, malformed, and empty fields', () => {
        expect(readImportPreviewInput(null)).toMatchObject({ ok: false });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, sourcePath: '' })).toMatchObject({ ok: false });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, strategy: 'merged' })).toMatchObject({
            ok: false,
            message: expect.stringContaining('strategy')
        });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, label: '  ' })).toMatchObject({ ok: false });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, solidIndexes: [] })).toMatchObject({ ok: false });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, solidIndexes: [0] })).toMatchObject({ ok: false });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, solidIndexes: [1.5] })).toMatchObject({ ok: false });
        expect(readImportPreviewInput({ ...IMPORT_PREVIEW_INPUT, material: 3 })).toMatchObject({ ok: false });
    });
});

describe('NukeCadAuthoringCapabilities', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('hides both tools while the kill switch is off', async () => {
        const harness = createHarness({ enabled: false });
        const previewCapability = harness.registered.get(PREVIEW_FEATURE_CHANGE_ID)!;
        const applyCapability = harness.registered.get(APPLY_FEATURE_CHANGE_ID)!;

        expect(previewCapability.when!(CONTEXT)).toBe(false);
        expect(applyCapability.when!(CONTEXT)).toBe(false);
        expect(await preview(harness)).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
    });

    it('previews a scalar edit with a real build and a temporary candidate', async () => {
        const harness = createHarness();
        const result = await preview(harness);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            title: 'CAD feature change',
            applyCapability: APPLY_FEATURE_CHANGE_ID
        });
        expect(result.data).toMatchObject({
            summary: 'pad-1 length: 100 → 120',
            impact: { solids: { before: 2, after: 2 } }
        });
        const request = harness.service.buildDocument.mock.calls[0][0];
        expect(request).toMatchObject({
            useCache: false,
            timeoutSeconds: 120,
            outputDirectory: expect.stringContaining('.nuke-ide/ai/cad-previews'),
            scriptPath: expect.stringMatching(/\.nuke-ai-preview-.*\.nuke-cad$/)
        });
        expect(request.jobId).toMatch(/^cad-ai-preview-/);
        expect(harness.fileService.create).toHaveBeenCalledTimes(1);
        expect(harness.fileService.delete).toHaveBeenCalledWith(expect.any(URI), { recursive: true, useTrash: false });
        expect(harness.fileService.delete).toHaveBeenCalledTimes(3);
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        expect(proposal.scope).toBe('features');
        if (proposal.scope !== 'features') {
            throw new Error('expected a feature proposal');
        }
        expect(proposal.before['pad-1']).toMatchObject({ length: 100 });
        expect(proposal.after['pad-1']).toMatchObject({ length: 120 });
        expect(harness.edits).toHaveLength(0);
    });

    it('rejects a change the pure engine does not allow and never builds', async () => {
        const harness = createHarness();
        const result = await harness.registered
            .get(PREVIEW_FEATURE_CHANGE_ID)!
            .invoke({ changes: [{ featureId: 'pad-1', param: 'radius', value: 2 }] }, CONTEXT);
        expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/not 'radius'|Unsupported/) });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.proposals.get('anything')).toBeUndefined();
    });

    it('rejects a failed preview build and cleans up', async () => {
        const harness = createHarness({ build: { ...BUILD_RESULT, success: false, error: 'build failed' } });
        const result = await preview(harness);
        expect(result).toMatchObject({ ok: false, message: 'build failed' });
        expect(harness.proposals.get('anything')).toBeUndefined();
        expect(harness.fileService.delete).toHaveBeenCalledTimes(3);
    });

    it('rejects a document that changed while the preview build was running', async () => {
        const harness = createHarness();
        harness.service.buildDocument.mockImplementation(async () => {
            harness.bumpRevision();
            return BUILD_RESULT;
        });
        expect(await preview(harness)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed while')
        });
        expect(harness.proposals.get('anything')).toBeUndefined();
    });

    it('rejects a topology or selector-map change', async () => {
        const count = createHarness({ build: { ...BUILD_RESULT, solidCount: 3 } });
        expect(await preview(count)).toMatchObject({ ok: false, message: expect.stringContaining('solid count') });
        expect(count.proposals.get('anything')).toBeUndefined();

        const selector = createHarness({ build: { ...BUILD_RESULT, selectorMap: { fuel: [1] } } });
        expect(await preview(selector)).toMatchObject({ ok: false, message: expect.stringContaining('selector map') });

        const noTessellation = createHarness({ build: { ...BUILD_RESULT, triangleCount: 0 } });
        expect(await preview(noTessellation)).toMatchObject({ ok: false, message: expect.stringContaining('no tessellation') });

        const badBox = createHarness({ build: { ...BUILD_RESULT, boundingBox: { min: [1, 1, 1], max: [1, 1, 1] } } });
        expect(await preview(badBox)).toMatchObject({ ok: false, message: expect.stringContaining('bounding box') });
    });

    it('applies a previewed change, schedules the rebuild, and registers undo', async () => {
        const harness = createHarness();
        const previewResult = await preview(harness);
        const proposalId = (previewResult.data as { proposalId: string }).proposalId;

        const result = await apply(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({ id: proposalId, title: 'CAD feature change' });
        expect(result.changeSet).not.toHaveProperty('applyCapability');
        expect(result.undoToken).toBe('undo-token-1');
        expect(harness.edits).toEqual([[{ id: 'pad-1', params: expect.objectContaining({ length: 120 }) }]]);
        expect(harness.commands).toContain('nuke.cad.rebuild');
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
    });

    it('rejects a stale proposal after the document revision changes', async () => {
        const harness = createHarness();
        const previewResult = await preview(harness);
        const proposalId = (previewResult.data as { proposalId: string }).proposalId;
        harness.bumpRevision();
        expect(await apply(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(harness.edits).toHaveLength(0);
    });

    it('restores the before params through the undo entry', async () => {
        const harness = createHarness();
        const previewResult = await preview(harness);
        const proposalId = (previewResult.data as { proposalId: string }).proposalId;
        await apply(harness, proposalId);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true, message: 'CAD change undone.' });
        expect(harness.edits).toHaveLength(2);
        expect(harness.edits[1]).toEqual([{ id: 'pad-1', params: expect.objectContaining({ length: 100 }) }]);
        expect(harness.commands.filter((command) => command === 'nuke.cad.rebuild')).toHaveLength(2);
    });

    it('rejects a missing proposal', async () => {
        const harness = createHarness();
        expect(await apply(harness, 'missing')).toMatchObject({ ok: false, message: expect.stringContaining('expired') });
        expect(harness.edits).toHaveLength(0);
    });

    it('hides topology preview and apply while the kill switch is off', async () => {
        const harness = topologyHarness({ enabled: false });

        expect(harness.registered.get(PREVIEW_TOPOLOGY_CHANGE_ID)!.when!(CONTEXT)).toBe(false);
        expect(harness.registered.get(APPLY_TOPOLOGY_CHANGE_ID)!.when!(CONTEXT)).toBe(false);
        expect(await previewTopology(harness)).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
    });

    it('previews a topology change with solid, selector, and region impact', async () => {
        const harness = topologyHarness();
        stubCandidateTessellation(harness);

        const result = await previewTopology(harness);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            title: 'CAD topology change',
            applyCapability: APPLY_TOPOLOGY_CHANGE_ID
        });
        expect(result.data).toMatchObject({
            summary: 'Change pattern Pattern 1 count 3 → 4',
            impact: { solids: { before: 3, after: 4 }, faces: { before: 18, after: 24 } },
            regionImpact: {
                solids: { before: 3, after: 4 },
                selectorMapChanged: true,
                regionCoverageChanged: false,
                addedSolidIds: [4],
                changedRegions: [{ selector: 'plate', group: 'plate_region', beforeSolidIds: [1, 2, 3], afterSolidIds: [1, 2, 3, 4] }]
            },
            openmcStatus: 'no-saved-project',
            build: { success: true, solidCount: 4, faceCount: 24, triangleCount: 48 }
        });
        expect(result.warnings).toEqual(['No saved OpenMC project is open; DAGMC references cannot be checked.']);
        expect(harness.ghostPreview.show).toHaveBeenCalledWith(
            expect.objectContaining({
                tessData: TOPOLOGY_PARSED_TESS,
                changedSolidIds: [],
                addedSolidIds: [4],
                removedSolidIds: []
            })
        );
        expect(harness.commands).toContain('nuke.cad.openReviewPanel');
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isTopologyProposal(proposal)) {
            throw new Error('expected a topology proposal');
        }
        expect(proposal.applyCapability).toBe(APPLY_TOPOLOGY_CHANGE_ID);
        expect(proposal.topology.actions).toEqual([PATTERN_COUNT_CHANGE]);
        expect(proposal.topology.before['pattern-1']).toEqual({ source: 'hole-1', count: 3, spacing: 5, axis: 'x' });
        expect(proposal.topology.after['pattern-1']).toEqual({ source: 'hole-1', count: 4, spacing: 5, axis: 'x' });
        expect(proposal.topology.afterRegions).toEqual([
            { kind: 'volume', selector: 'plate', group: 'plate_region', name: 'plate_region', solidIds: [1, 2, 3, 4] }
        ]);
        expect(harness.replacements).toHaveLength(0);
    });

    it('explains a blocked region impact and omits the chat apply action', async () => {
        const harness = topologyHarness({
            build: TOPOLOGY_BUILD_CHANGED_GROUP,
            files: { [OPENMC_PROJECT_PATH]: OPENMC_PROJECT_JSON }
        });
        stubCandidateTessellation(harness);

        const result = await previewTopology(harness, { changes: [PATTERN_COUNT_CHANGE] }, OPENMC_CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.changeSet?.applyCapability).toBeUndefined();
        expect(result.data).toMatchObject({
            openmcStatus: 'saved-project',
            blockedRegions: [{ reference: 'plate_region', kind: 'dagmc-group' }]
        });
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isTopologyProposal(proposal)) {
            throw new Error('expected a topology proposal');
        }
        expect(proposal.applyCapability).toBe(APPLY_TOPOLOGY_CHANGE_ID);
        expect(proposal.topology.blockedRegions).toHaveLength(1);
        expect(proposal.topology.blockedRegions[0].message).toContain('plate_region');
        expect(harness.ghostPreview.show).toHaveBeenCalledTimes(1);
    });

    it('rejects failed, empty, and stale topology candidates', async () => {
        const failed = topologyHarness({ build: { ...TOPOLOGY_BUILD_AFTER, success: false, error: 'topology build failed' } });
        expect(await previewTopology(failed)).toMatchObject({ ok: false, message: 'topology build failed' });
        expect(failed.proposals.list()).toHaveLength(0);

        const featureFailure = topologyHarness({
            build: { ...TOPOLOGY_BUILD_AFTER, featureResults: [{ featureId: 'hole-1', status: 'failed' }] }
        });
        expect(await previewTopology(featureFailure)).toMatchObject({
            ok: false,
            message: expect.stringContaining('hole-1')
        });

        const noSolids = topologyHarness({ build: { ...TOPOLOGY_BUILD_AFTER, solidCount: 0 } });
        expect(await previewTopology(noSolids)).toMatchObject({ ok: false, message: expect.stringContaining('no solids') });

        const noTessellation = topologyHarness({ build: { ...TOPOLOGY_BUILD_AFTER, triangleCount: 0 } });
        expect(await previewTopology(noTessellation)).toMatchObject({
            ok: false,
            message: expect.stringContaining('no tessellation')
        });

        const badBox = topologyHarness({ build: { ...TOPOLOGY_BUILD_AFTER, boundingBox: { min: [1, 1, 1], max: [1, 1, 1] } } });
        expect(await previewTopology(badBox)).toMatchObject({
            ok: false,
            message: expect.stringContaining('bounding box')
        });

        const revision = topologyHarness();
        revision.service.buildDocument.mockImplementation(async () => {
            revision.bumpRevision();
            return TOPOLOGY_BUILD_AFTER;
        });
        expect(await previewTopology(revision)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed while')
        });
        expect(revision.proposals.list()).toHaveLength(0);

        const epoch = topologyHarness();
        epoch.service.buildDocument.mockImplementation(async () => {
            epoch.bumpEpoch();
            return TOPOLOGY_BUILD_AFTER;
        });
        expect(await previewTopology(epoch)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed while')
        });
        expect(epoch.proposals.list()).toHaveLength(0);
    });

    it('copies the region manifest beside the candidate and removes the copy', async () => {
        const sidecarPath = `${WORKSPACE}/pincell.regions.json`;
        const harness = createHarness({ files: { [sidecarPath]: SIDECAR_CONTENT } });

        const result = await preview(harness);

        expect(result.ok).toBe(true);
        const candidatePath = harness.service.buildDocument.mock.calls[0][0].scriptPath as string;
        const candidateSidecar = `${candidatePath.slice(0, -'.nuke-cad'.length)}.regions.json`;
        expect(harness.fileService.exists).toHaveBeenCalledWith(expect.any(URI));
        const readUri = harness.fileService.readFile.mock.calls[0][0] as URI;
        expect(readUri.path.toString()).toBe(sidecarPath);
        expect(harness.fileService.create).toHaveBeenCalledWith(expect.any(URI), SIDECAR_CONTENT);
        const candidateSidecarCreated = harness.fileService.create.mock.calls.some(
            ([uri]) => (uri as URI).path.toString() === candidateSidecar
        );
        expect(candidateSidecarCreated).toBe(true);
        expect(harness.files.has(candidateSidecar)).toBe(false);
        expect(harness.files.get(sidecarPath)).toBe(SIDECAR_CONTENT);
        const deleted = harness.fileService.delete.mock.calls.map(([uri]) => (uri as URI).path.toString());
        expect(deleted).toContain(candidateSidecar);
    });

    it('fails the preview when the region manifest cannot be read', async () => {
        const sidecarPath = `${WORKSPACE}/pincell.regions.json`;
        const harness = createHarness({ files: { [sidecarPath]: SIDECAR_CONTENT } });
        harness.fileService.readFile.mockRejectedValueOnce(new Error('permission denied'));

        const result = await preview(harness);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('could not be copied') });
        expect(result.message).toContain('permission denied');
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.proposals.list()).toHaveLength(0);
        expect(harness.fileService.delete).toHaveBeenCalledTimes(3);
    });

    it('applies a topology preview after acknowledgement, schedules the rebuild, and registers undo', async () => {
        const harness = topologyHarness();
        const proposalId = await previewedTopologyProposal(harness);

        const result = await applyTopology(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            id: proposalId,
            title: 'CAD topology change',
            applyCapability: APPLY_TOPOLOGY_CHANGE_ID
        });
        expect(result.undoToken).toBe('undo-token-1');
        expect(result.data).toMatchObject({
            proposalId,
            documentPath: DOCUMENT_PATH,
            rebuildScheduled: true,
            backupPath: expect.stringContaining('.nuke-ai-backup-'),
            regionImpact: { solids: { before: 3, after: 4 }, selectorMapChanged: true }
        });
        expect(harness.replacements).toEqual([[{ id: 'pattern-1', params: { source: 'hole-1', count: 4, spacing: 5, axis: 'x' } }]]);
        expect(harness.commands).toContain('nuke.cad.rebuild');
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
    });

    it('applies a through-hole replacement without the blind depth key', async () => {
        const harness = topologyHarness();
        const previewResult = await previewTopology(harness, {
            changes: [{ featureId: 'hole-1', action: 'holeDepthMode', mode: 'through' }]
        });
        expect(previewResult.ok).toBe(true);
        expect(previewResult.data).toMatchObject({ summary: 'Open hole Hole 1 through' });
        const proposalId = (previewResult.data as { proposalId: string }).proposalId;

        const result = await applyTopology(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(harness.replacements).toHaveLength(1);
        expect(harness.replacements[0][0]).toMatchObject({ id: 'hole-1', params: { center: [0, 0], diameter: 2 } });
        expect(harness.replacements[0][0].params).not.toHaveProperty('depth');
        expect(harness.currentDocument().features.find((feature) => feature.id === 'hole-1')!.params).toMatchObject({
            diameter: 2
        });
        expect(harness.currentDocument().features.find((feature) => feature.id === 'hole-1')!.params).not.toHaveProperty('depth');

        await harness.undoEntries[0].undo();

        expect(harness.replacements[1]).toMatchObject([{ id: 'hole-1', params: { diameter: 2, depth: 4 } }]);
    });

    it('requires an explicit region-impact acknowledgement', async () => {
        const harness = topologyHarness();
        const proposalId = await previewedTopologyProposal(harness);

        expect(await applyTopology(harness, proposalId, CONTEXT, false)).toMatchObject({
            ok: false,
            message: 'Acknowledge the region impact before applying this topology change.'
        });
        expect(harness.replacements).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();
    });

    it('rejects a blocked topology proposal naming the saved reference', async () => {
        const harness = topologyHarness({
            build: TOPOLOGY_BUILD_CHANGED_GROUP,
            files: { [OPENMC_PROJECT_PATH]: OPENMC_PROJECT_JSON }
        });
        const proposalId = await previewedTopologyProposal(harness, OPENMC_CONTEXT);

        const result = await applyTopology(harness, proposalId, OPENMC_CONTEXT);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('plate_region') });
        expect(result.message).toContain('saved OpenMC reference');
        expect(harness.replacements).toHaveLength(0);
    });

    it('rejects apply when the active OpenMC project changed', async () => {
        const harness = topologyHarness({ files: { [OPENMC_PROJECT_PATH]: OPENMC_PROJECT_JSON } });
        const proposalId = await previewedTopologyProposal(harness, OPENMC_CONTEXT);

        expect(await applyTopology(harness, proposalId, CONTEXT)).toMatchObject({
            ok: false,
            message: 'The active OpenMC project changed after this preview. Preview the change again.'
        });
        expect(harness.replacements).toHaveLength(0);
    });

    it('re-checks saved OpenMC references when applying', async () => {
        const harness = topologyHarness({ build: TOPOLOGY_BUILD_CHANGED_GROUP });
        const proposalId = await previewedTopologyProposal(harness, OPENMC_CONTEXT);
        const proposal = harness.proposals.get(proposalId)!;
        if (!isTopologyProposal(proposal)) {
            throw new Error('expected a topology proposal');
        }
        expect(proposal.topology.blockedRegions).toHaveLength(0);

        harness.files.set(new URI(OPENMC_PROJECT_PATH).path.toString(), OPENMC_PROJECT_JSON);
        const result = await applyTopology(harness, proposalId, OPENMC_CONTEXT);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('plate_region') });
        expect(harness.replacements).toHaveLength(0);
    });

    it('rejects a stale topology proposal after the revision or feature params change', async () => {
        const revision = topologyHarness();
        const revisionProposal = await previewedTopologyProposal(revision);
        revision.bumpRevision();
        expect(await applyTopology(revision, revisionProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(revision.replacements).toHaveLength(0);

        const params = topologyHarness();
        const paramsProposal = await previewedTopologyProposal(params);
        const pattern = params.currentDocument().features.find((feature) => feature.id === 'pattern-1')!;
        pattern.params = { count: 5, spacing: 5 };
        expect(await applyTopology(params, paramsProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining("Feature 'pattern-1' changed after this preview")
        });
        expect(params.replacements).toHaveLength(0);
    });

    it('undoes a topology change by replacing the before snapshots exactly', async () => {
        const harness = topologyHarness();
        const proposalId = await previewedTopologyProposal(harness);
        await applyTopology(harness, proposalId);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true, message: 'CAD topology change undone.' });
        expect(harness.replacements).toHaveLength(2);
        expect(harness.replacements[1]).toEqual([{ id: 'pattern-1', params: { source: 'hole-1', count: 3, spacing: 5, axis: 'x' } }]);
        expect(harness.commands.filter((command) => command === 'nuke.cad.rebuild')).toHaveLength(2);
    });

    it('rejects undo after the revision or applied params change', async () => {
        const revision = topologyHarness();
        const revisionProposal = await previewedTopologyProposal(revision);
        await applyTopology(revision, revisionProposal);
        revision.bumpRevision();
        expect(await revision.undoEntries[0].undo()).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this edit')
        });
        expect(revision.replacements).toHaveLength(1);

        const params = topologyHarness();
        const paramsProposal = await previewedTopologyProposal(params);
        await applyTopology(params, paramsProposal);
        const pattern = params.currentDocument().features.find((feature) => feature.id === 'pattern-1')!;
        pattern.params = { count: 5, spacing: 5 };
        expect(await params.undoEntries[0].undo()).toMatchObject({
            ok: false,
            message: expect.stringContaining("Feature 'pattern-1' changed after apply")
        });
        expect(params.replacements).toHaveLength(1);
    });

    it('keeps feature, sketch, and topology applies separate', async () => {
        const harness = topologyHarness();
        const proposalId = await previewedTopologyProposal(harness);
        expect(await apply(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('topology change')
        });
        expect(await applySketch(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('topology change')
        });
        expect(harness.replacements).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();

        const featureHarness = createHarness();
        const featurePreview = await preview(featureHarness);
        const featureProposalId = (featurePreview.data as { proposalId: string }).proposalId;
        expect(await applyTopology(featureHarness, featureProposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('feature change')
        });

        const sketchHarness = createHarness();
        const sketchProposalId = await previewedSketchProposal(sketchHarness);
        expect(await applyTopology(sketchHarness, sketchProposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('sketch change')
        });
    });

    it('lists sketch dimensions without the authoring preference', async () => {
        const harness = createHarness({ enabled: false });
        const capability = harness.registered.get(LIST_SKETCH_DIMENSIONS_ID)!;

        expect(capability.when!(CONTEXT)).toBe(true);
        const result = await capability.invoke({}, CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            parameters: { fuelRadius: 0.4 },
            sketches: [
                {
                    id: 'sketch-1',
                    name: 'fuel-sketch',
                    datumId: 'datum-xy',
                    consumedByFeatureIds: ['pad-1'],
                    dimensions: [{ id: 'dim-1', kind: 'radius', driving: true, value: 0.4 }]
                }
            ]
        });
    });

    it('hides sketch preview while the kill switch is off and rejects unsaved or unbuilt documents', async () => {
        const disabled = createHarness({ enabled: false });
        expect(disabled.registered.get(PREVIEW_SKETCH_CHANGE_ID)!.when!(CONTEXT)).toBe(false);
        expect(await previewSketch(disabled)).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
        expect(disabled.sketchPrepare).not.toHaveBeenCalled();

        const unsaved = createHarness({ saved: false });
        expect(await previewSketch(unsaved)).toMatchObject({ ok: false, message: expect.stringContaining('Open a saved') });
        expect(unsaved.sketchPrepare).not.toHaveBeenCalled();

        const noModel = createHarness({ hasModel: false });
        expect(await previewSketch(noModel)).toMatchObject({ ok: false, message: expect.stringContaining('Open a saved') });
        expect(noModel.sketchPrepare).not.toHaveBeenCalled();
    });

    it('returns the planner error without building', async () => {
        const harness = createHarness({
            prepare: async () => ({ ok: false, code: 'dimension-not-found', message: "Dimension 'dim-9' not found" })
        });
        expect(await previewSketch(harness)).toMatchObject({ ok: false, message: "Dimension 'dim-9' not found" });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.proposals.list()).toHaveLength(0);
    });

    it('previews a sketch edit with a real build and a sketch proposal', async () => {
        const harness = createHarness();
        vi.spyOn(
            harness.capabilities as unknown as { readCandidateTessellation: () => Promise<typeof PARSED_TESS> },
            'readCandidateTessellation'
        ).mockResolvedValue(PARSED_TESS);

        const result = await previewSketch(harness);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            title: 'CAD sketch dimension change',
            applyCapability: APPLY_SKETCH_CHANGE_ID
        });
        expect(result.data).toMatchObject({
            summary: 'Change sketch fuel-sketch: dim-1 radius 0.4 → 0.44',
            impact: { solids: { before: 2, after: 2 } },
            sketch: { targetSketchId: 'sketch-1', affectedFeatureIds: ['pad-1'] }
        });
        expect(harness.sketchPrepare).toHaveBeenCalledTimes(1);
        expect(harness.sketchPrepare.mock.calls[0][1]).toEqual(SKETCH_REQUEST);
        const request = harness.service.buildDocument.mock.calls[0][0];
        expect(request).toMatchObject({
            useCache: false,
            timeoutSeconds: 120,
            outputDirectory: expect.stringContaining('.nuke-ide/ai/cad-previews'),
            scriptPath: expect.stringMatching(/\.nuke-ai-preview-.*\.nuke-cad$/)
        });
        expect(request.jobId).toMatch(/^cad-ai-preview-/);
        expect(harness.fileService.create).toHaveBeenCalledTimes(1);
        expect(harness.fileService.delete).toHaveBeenCalledTimes(3);
        expect(harness.ghostPreview.show).toHaveBeenCalledTimes(1);
        expect(harness.commands).toContain('nuke.cad.openReviewPanel');

        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isSketchProposal(proposal)) {
            throw new Error('expected a sketch proposal');
        }
        expect(proposal.scope).toBe('sketch');
        expect(proposal.applyCapability).toBe(APPLY_SKETCH_CHANGE_ID);
        expect(proposal.sketch.targetSketchName).toBe('fuel-sketch');
        expect(proposal.sketch.beforeSketches['sketch-1']?.dimensions?.[0].value).toBe(0.4);
        expect(proposal.sketch.afterSketches['sketch-1']?.dimensions?.[0].value).toBe(0.44);
        expect(proposal.sketch.affectedFeatureIds).toEqual(['pad-1']);
        expect(proposal.sketch.solver.status).toBe('converged');
        expect(harness.sketchEdits).toHaveLength(0);
    });

    it('rejects a sketch preview that changes topology or arrives stale', async () => {
        const count = createHarness({ build: { ...BUILD_RESULT, solidCount: 3 } });
        expect(await previewSketch(count)).toMatchObject({ ok: false, message: expect.stringContaining('solid count') });
        expect(count.proposals.list()).toHaveLength(0);

        const selector = createHarness({ build: { ...BUILD_RESULT, selectorMap: { fuel: [1] } } });
        expect(await previewSketch(selector)).toMatchObject({ ok: false, message: expect.stringContaining('selector map') });
        expect(selector.proposals.list()).toHaveLength(0);

        const drift = createHarness();
        drift.service.buildDocument.mockImplementation(async () => {
            drift.bumpRevision();
            return BUILD_RESULT;
        });
        expect(await previewSketch(drift)).toMatchObject({ ok: false, message: expect.stringContaining('changed while') });
        expect(drift.proposals.list()).toHaveLength(0);
    });

    it('applies a sketch preview, schedules the rebuild, and registers undo', async () => {
        const harness = createHarness();
        const proposalId = await previewedSketchProposal(harness);

        const result = await applySketch(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            id: proposalId,
            title: 'CAD sketch dimension change',
            applyCapability: APPLY_SKETCH_CHANGE_ID
        });
        expect(result.undoToken).toBe('undo-token-1');
        expect(result.data).toMatchObject({
            proposalId,
            documentPath: DOCUMENT_PATH,
            rebuildScheduled: true,
            affectedFeatureIds: ['pad-1'],
            backupPath: expect.stringContaining('.nuke-ai-backup-')
        });
        expect(harness.sketchEdits).toHaveLength(1);
        expect(harness.sketchEdits[0].sketches[0].dimensions?.[0].value).toBe(0.44);
        expect(harness.commands).toContain('nuke.cad.rebuild');
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
    });

    it('rejects a stale sketch proposal after the revision, parameter, or sketch changes', async () => {
        const revision = createHarness();
        const revisionProposal = await previewedSketchProposal(revision);
        revision.bumpRevision();
        expect(await applySketch(revision, revisionProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(revision.sketchEdits).toHaveLength(0);

        const parameter = createHarness({
            prepare: async (doc) => {
                const prepared = createPreparedSketchEdit(doc);
                return { ok: true, result: { ...prepared, beforeParameters: { fuelRadius: 0.4 }, afterParameters: { fuelRadius: 0.5 } } };
            }
        });
        const parameterProposal = await previewedSketchProposal(parameter);
        parameter.currentDocument().parameters.fuelRadius = 0.6;
        expect(await applySketch(parameter, parameterProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining("Parameter 'fuelRadius' changed")
        });
        expect(parameter.sketchEdits).toHaveLength(0);

        const sketch = createHarness();
        const sketchProposal = await previewedSketchProposal(sketch);
        sketch.currentDocument().sketches[0].dimensions![0].value = 0.41;
        expect(await applySketch(sketch, sketchProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining("Sketch 'sketch-1' changed")
        });
        expect(sketch.sketchEdits).toHaveLength(0);
    });

    it('undoes a sketch change through the undo entry', async () => {
        const harness = createHarness();
        const proposalId = await previewedSketchProposal(harness);
        await applySketch(harness, proposalId);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true, message: 'CAD sketch change undone.' });
        expect(harness.sketchEdits).toHaveLength(2);
        expect(harness.sketchEdits[1].sketches[0].dimensions?.[0].value).toBe(0.4);
        expect(harness.commands.filter((command) => command === 'nuke.cad.rebuild')).toHaveLength(2);
    });

    it('rejects a sketch proposal through the feature apply capability', async () => {
        const harness = createHarness();
        const proposalId = await previewedSketchProposal(harness);

        expect(await apply(harness, proposalId)).toMatchObject({ ok: false, message: expect.stringContaining('sketch change') });
        expect(harness.edits).toHaveLength(0);
        expect(harness.sketchEdits).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();
    });

    it('hides every import capability while the kill switch is off', async () => {
        const harness = importHarness({ enabled: false });

        for (const id of [INSPECT_IMPORT_SOURCE_ID, PREVIEW_IMPORT_BODIES_ID, APPLY_IMPORT_BODIES_ID]) {
            expect(harness.registered.get(id)!.when!(CONTEXT)).toBe(false);
        }
        expect(await inspectImport(harness)).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
        expect(harness.fileDialog.showOpenDialog).not.toHaveBeenCalled();
        expect(harness.service.inspectImportSource).not.toHaveBeenCalled();
    });

    it('registers the import capabilities only for a saved active document', () => {
        const harness = importHarness();
        const unsaved = importHarness({ saved: false });
        const noModel = importHarness({ hasModel: false });

        for (const id of [INSPECT_IMPORT_SOURCE_ID, PREVIEW_IMPORT_BODIES_ID, APPLY_IMPORT_BODIES_ID]) {
            expect(harness.registered.get(id)!.when!(CONTEXT)).toBe(true);
            expect(harness.registered.get(id)!.risk).toBe(id === APPLY_IMPORT_BODIES_ID ? 'execute' : 'read');
            expect(unsaved.registered.get(id)!.when!(CONTEXT)).toBe(false);
            expect(noModel.registered.get(id)!.when!(CONTEXT)).toBe(false);
        }
    });

    it('returns a clean cancellation when the import picker is dismissed', async () => {
        const harness = importHarness({ pickImport: async () => undefined });

        const result = await inspectImport(harness, {});

        expect(result).toMatchObject({ ok: false, message: 'No CAD import source was selected.' });
        expect(harness.fileDialog.showOpenDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Authorize CAD import source',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'CAD Exchange Files': ['step', 'stp', 'iges', 'igs', 'brep'] }
            })
        );
        expect(harness.service.inspectImportSource).not.toHaveBeenCalled();
        expect(harness.proposals.list()).toHaveLength(0);
    });

    it('asks once for a direct path and reuses the session grant', async () => {
        const harness = importHarness();

        const first = await inspectImport(harness, { sourcePath: IMPORT_PATH });
        const second = await inspectImport(harness, { sourcePath: IMPORT_PATH });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(harness.fileDialog.showOpenDialog).toHaveBeenCalledTimes(1);
        expect(harness.service.inspectImportSource).toHaveBeenCalledTimes(2);
        expect(harness.service.inspectImportSource).toHaveBeenLastCalledWith({
            sourcePath: IMPORT_PATH,
            targetUnits: 'mm',
            maxSolids: 500
        });
        expect(first.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            documentUnits: 'mm',
            source: {
                path: IMPORT_PATH,
                sourceHash: IMPORT_HASH,
                sourceSize: IMPORT_SIZE,
                sourceFormat: 'step',
                fileUnit: 'mm',
                effectiveUnit: 'mm'
            },
            solids: IMPORT_SOLIDS
        });
    });

    it('skips the picker for a document-owned .parts source', async () => {
        const harness = importHarness();

        const result = await inspectImport(harness, { sourcePath: PARTS_IMPORT_PATH });

        expect(result.ok).toBe(true);
        expect(harness.fileDialog.showOpenDialog).not.toHaveBeenCalled();
        expect(harness.service.inspectImportSource).toHaveBeenCalledWith({
            sourcePath: PARTS_IMPORT_PATH,
            targetUnits: 'mm',
            maxSolids: 500
        });
    });

    it('rejects unsafe direct paths before opening the picker or inspecting', async () => {
        const outside = `${WORKSPACE}-evil/gui_pincell.step`;
        const symlink = `${WORKSPACE}/linked.step`;
        const oversized = `${WORKSPACE}/oversized.step`;
        const unsupported = `${WORKSPACE}/notes.txt`;
        const directory = `${WORKSPACE}/bundle.step`;
        const cases: { sourcePath: string; filesystem: Record<string, Partial<FileStat>>; message: RegExp }[] = [
            { sourcePath: 'relative/gui_pincell.step', filesystem: {}, message: /absolute/ },
            { sourcePath: outside, filesystem: { [outside]: { isFile: true, size: 1 } }, message: /outside every workspace root/ },
            { sourcePath: symlink, filesystem: { [symlink]: { isSymbolicLink: true } }, message: /symbolic link/ },
            {
                sourcePath: oversized,
                filesystem: { [oversized]: { isFile: true, size: MAX_IMPORT_SOURCE_BYTES + 1 } },
                message: /256 MiB/
            },
            { sourcePath: unsupported, filesystem: { [unsupported]: { isFile: true, size: 1 } }, message: /Unsupported/ },
            { sourcePath: directory, filesystem: { [directory]: { isDirectory: true } }, message: /regular file/ }
        ];

        for (const entry of cases) {
            const harness = importHarness({ filesystem: entry.filesystem });
            const result = await inspectImport(harness, { sourcePath: entry.sourcePath });

            expect(result.ok).toBe(false);
            expect(result.message).toMatch(entry.message);
            expect(harness.fileDialog.showOpenDialog).not.toHaveBeenCalled();
            expect(harness.service.inspectImportSource).not.toHaveBeenCalled();
        }
    });

    it('rejects outside, symlinked, oversized, and unsupported files chosen in the picker', async () => {
        const outside = `${WORKSPACE}-evil/gui_pincell.step`;
        const symlink = `${WORKSPACE}/picked.step`;
        const oversized = `${WORKSPACE}/picked-large.step`;
        const unsupported = `${WORKSPACE}/picked.txt`;
        const cases: { pickImport: string; filesystem: Record<string, Partial<FileStat>>; message: RegExp }[] = [
            { pickImport: outside, filesystem: { [outside]: { isFile: true, size: 1 } }, message: /outside every workspace root/ },
            { pickImport: symlink, filesystem: { [symlink]: { isSymbolicLink: true } }, message: /symbolic link/ },
            {
                pickImport: oversized,
                filesystem: { [oversized]: { isFile: true, size: MAX_IMPORT_SOURCE_BYTES + 1 } },
                message: /256 MiB/
            },
            { pickImport: unsupported, filesystem: { [unsupported]: { isFile: true, size: 1 } }, message: /Unsupported/ }
        ];

        for (const entry of cases) {
            const harness = importHarness({ pickImport: entry.pickImport, filesystem: entry.filesystem });
            const result = await inspectImport(harness, {});

            expect(result.ok).toBe(false);
            expect(result.message).toMatch(entry.message);
            expect(harness.service.inspectImportSource).not.toHaveBeenCalled();
        }
    });

    it('rejects failed, hashless, and solid-less inspections without caching a grant', async () => {
        const failed = importHarness({ inspection: { success: false, error: 'reader exploded' } });
        expect(await inspectImport(failed)).toMatchObject({ ok: false, message: 'reader exploded' });

        const hashless = importHarness({ inspection: { sourceHash: undefined } });
        expect(await inspectImport(hashless)).toMatchObject({ ok: false, message: expect.stringContaining('SHA-256') });

        const empty = importHarness({ inspection: { solids: [], solidCount: 0 } });
        expect(await inspectImport(empty)).toMatchObject({ ok: false, message: expect.stringContaining('no solids') });

        const preview = await previewImport(hashless, IMPORT_PREVIEW_INPUT);
        expect(preview).toMatchObject({ ok: false, message: expect.stringContaining('Inspect and authorize') });
    });

    it('uses the requested source unit and reuses a grant across previews', async () => {
        const harness = importHarness();
        const inspected = await inspectImport(harness, { sourcePath: IMPORT_PATH });
        expect(inspected.ok).toBe(true);

        const first = await previewImport(harness, { ...IMPORT_PREVIEW_INPUT, sourceUnit: 'm' });
        const second = await previewImport(harness, { ...IMPORT_PREVIEW_INPUT, solidIndexes: [3] });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(harness.fileDialog.showOpenDialog).toHaveBeenCalledTimes(1);
        expect(harness.service.inspectImportSource.mock.calls.map(([request]) => request)).toEqual([
            { sourcePath: IMPORT_PATH, targetUnits: 'mm', maxSolids: 500 },
            { sourcePath: IMPORT_PATH, sourceUnit: 'm', targetUnits: 'mm', maxSolids: 500 },
            { sourcePath: IMPORT_PATH, targetUnits: 'mm', maxSolids: 500 }
        ]);
        const firstProposal = harness.proposals.get((first.data as { proposalId: string }).proposalId)!;
        if (!isImportProposal(firstProposal)) {
            throw new Error('expected an import proposal');
        }
        expect(firstProposal.import.source.sourceUnit).toBe('m');
        expect(firstProposal.import.source.effectiveUnit).toBe('m');
    });

    it('plans per-solid and single-body imports with unique names', async () => {
        const harness = importHarness();
        harness.currentDocument().bodies.push({ id: 'body-existing', name: 'fuel' });
        await authorizeImport(harness);

        const perSolid = await previewImport(harness);
        expect(perSolid.ok).toBe(true);
        const perProposal = harness.proposals.get((perSolid.data as { proposalId: string }).proposalId)!;
        if (!isImportProposal(perProposal)) {
            throw new Error('expected an import proposal');
        }
        expect(perProposal.import.strategy).toBe('perSolid');
        expect(perProposal.import.solidCount).toBe(3);
        expect(perProposal.import.selectedSolids).toHaveLength(2);
        expect(perProposal.import.drafts.map((draft) => draft.name)).toEqual(['fuel 2', 'clad']);
        expect(perProposal.import.drafts[0].params.selection).toEqual({
            mode: 'solids',
            solids: [{ index: 1, signature: { faceCount: 6, volume: 10 } }]
        });
        expect(perProposal.summary).toBe('Import 2 solids from gui_pincell.step as 2 bodies');
        expect(perProposal.changes).toEqual([
            { path: 'bodies.fuel 2', label: 'Body fuel 2', kind: 'add', after: 'fuel 2' },
            { path: 'bodies.clad', label: 'Body clad', kind: 'add', after: 'clad' }
        ]);
        expect(perProposal.import.source.sourceHash).toBe(IMPORT_HASH);

        const single = await previewImport(harness, {
            sourcePath: IMPORT_PATH,
            strategy: 'single',
            label: 'assembly',
            solidIndexes: [1, 2]
        });
        expect(single.ok).toBe(true);
        const singleProposal = harness.proposals.get((single.data as { proposalId: string }).proposalId)!;
        if (!isImportProposal(singleProposal)) {
            throw new Error('expected an import proposal');
        }
        expect(singleProposal.import.drafts).toHaveLength(1);
        expect(singleProposal.import.drafts[0].name).toBe('assembly');
        expect(singleProposal.import.drafts[0].params.selection).toEqual({
            mode: 'solids',
            solids: [
                { index: 1, signature: { faceCount: 6, volume: 10 } },
                { index: 2, signature: { faceCount: 8, volume: 20 } }
            ]
        });
        expect(singleProposal.import.selectedSolids.map((solid) => solid.index)).toEqual([1, 2]);
    });

    it('records the total inspection solid count separately from the selection', async () => {
        const harness = importHarness({ inspection: { solidCount: undefined } });
        await authorizeImport(harness);

        const result = await previewImport(harness);

        expect(result.ok).toBe(true);
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isImportProposal(proposal)) {
            throw new Error('expected an import proposal');
        }
        expect(proposal.import.solidCount).toBe(3);
        expect(proposal.import.selectedSolids).toHaveLength(2);
    });

    it('validates and applies one material tag to the whole batch', async () => {
        const harness = importHarness();
        await authorizeImport(harness);
        const result = await previewImport(harness, { ...IMPORT_PREVIEW_INPUT, material: ' steel ' });

        expect(result.ok).toBe(true);
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isImportProposal(proposal)) {
            throw new Error('expected an import proposal');
        }
        expect(proposal.import.drafts.map((draft) => draft.material)).toEqual(['steel', 'steel']);
        expect(proposal.import.bodies.map((body) => body.material)).toEqual(['steel', 'steel']);
        expect(proposal.import.warnings).not.toContainEqual(expect.stringContaining('No material tag'));

        const invalid = importHarness();
        const rejected = await previewImport(invalid, { ...IMPORT_PREVIEW_INPUT, material: 'mat:UO2' });
        expect(rejected).toMatchObject({ ok: false, message: expect.stringContaining("Drop the 'mat:' prefix") });
        expect(invalid.service.inspectImportSource).not.toHaveBeenCalled();
        expect(invalid.proposals.list()).toHaveLength(0);
    });

    it('warns about external sources, unknown units, excluded solids, and missing material', async () => {
        const outside = '/workspace/other/gui_pincell.step';
        const context: NukeCapabilityContext = { workspaceRoots: [WORKSPACE, '/workspace/other'], activeCadDocument: DOCUMENT_PATH };
        const harness = importHarness({
            pickImport: outside,
            inspection: {
                fileUnit: undefined,
                effectiveUnit: undefined,
                warnings: ['Reader note']
            },
            filesystem: {
                [outside]: { isFile: true, size: IMPORT_SIZE }
            }
        });
        await inspectImport(harness, { sourcePath: outside }, context);

        const result = await previewImport(
            harness,
            {
                sourcePath: outside,
                strategy: 'single',
                label: 'assembly',
                solidIndexes: [1]
            },
            context
        );

        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual(
            expect.arrayContaining([
                'Reader note',
                expect.stringContaining('outside the document folder'),
                expect.stringContaining('unit is unknown'),
                expect.stringContaining('Importing 1 of 3'),
                expect.stringContaining('No material tag')
            ])
        );
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isImportProposal(proposal)) {
            throw new Error('expected an import proposal');
        }
        expect(proposal.import.solidCount).toBe(3);
        expect(proposal.import.selectedSolids).toHaveLength(1);
        expect(proposal.import.warnings).toEqual(result.warnings);
    });

    it('previews without mutating the store, building geometry, or publishing a ghost', async () => {
        const harness = importHarness();
        await authorizeImport(harness);
        const revision = harness.store.revision;

        const result = await previewImport(harness);

        expect(result.ok).toBe(true);
        expect(harness.store.revision).toBe(revision);
        expect(harness.imports).toHaveLength(0);
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.ghostPreview.show).not.toHaveBeenCalled();
        expect(harness.ghostPreview.clear).not.toHaveBeenCalled();
        expect(harness.commands).toContain('nuke.cad.openReviewPanel');
        expect(result.changeSet).toMatchObject({
            title: 'CAD import bodies',
            applyCapability: APPLY_IMPORT_BODIES_ID
        });
        expect(result.data).toMatchObject({
            proposalId: expect.any(String),
            summary: 'Import 2 solids from gui_pincell.step as 2 bodies'
        });
        expect(result.data).not.toHaveProperty('impact');
        expect(result.data).not.toHaveProperty('build');
    });

    it('requires an authorized import proposal for apply', async () => {
        const harness = importHarness();
        expect(await applyImport(harness, 'missing')).toMatchObject({
            ok: false,
            message: expect.stringContaining('expired')
        });

        const featureHarness = createHarness();
        const featurePreview = await preview(featureHarness);
        const featureProposalId = (featurePreview.data as { proposalId: string }).proposalId;
        expect(await applyImport(featureHarness, featureProposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('feature change')
        });
        expect(featureHarness.imports).toHaveLength(0);
    });

    it('applies one atomic import batch with a backup, rebuild, ids, and undo token', async () => {
        const harness = importHarness();
        const proposalId = await previewedImportProposal(harness);
        const proposal = harness.proposals.get(proposalId)!;
        if (!isImportProposal(proposal)) {
            throw new Error('expected an import proposal');
        }
        const inspectedBefore = harness.service.inspectImportSource.mock.calls.length;

        const result = await applyImport(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(result.message).toBe('CAD import applied; rebuild scheduled.');
        expect(result.undoToken).toBe('undo-token-1');
        expect(result.changeSet).toMatchObject({ id: proposalId, title: 'CAD import bodies' });
        expect(result.changeSet).not.toHaveProperty('applyCapability');
        expect(result.data).toMatchObject({
            proposalId,
            bodyIds: ['import-body-1-1', 'import-body-1-2'],
            featureIds: ['import-feature-1-1', 'import-feature-1-2'],
            documentPath: DOCUMENT_PATH,
            revision: 4,
            backupPath: `${WORKSPACE}/.nuke-ai-backup-pincell.nuke-cad`,
            rebuildScheduled: true
        });
        expect(harness.service.inspectImportSource).toHaveBeenCalledTimes(inspectedBefore + 1);
        expect(harness.service.inspectImportSource).toHaveBeenLastCalledWith({
            sourcePath: IMPORT_PATH,
            targetUnits: 'mm',
            maxSolids: 500
        });
        expect(harness.imports).toHaveLength(1);
        expect(harness.imports[0].bodies).toEqual(proposal.import.drafts);
        expect(harness.currentDocument().bodies.map((body) => body.name)).toEqual(['Body 1', 'fuel', 'clad']);
        expect(harness.currentDocument().features.filter((feature) => feature.type === 'import')).toHaveLength(2);
        expect(harness.commands).toContain('nuke.cad.rebuild');
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.files.has(new URI(`${WORKSPACE}/.nuke-ai-backup-pincell.nuke-cad`).path.toString())).toBe(true);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
    });

    it('rejects a changed source hash, size, or format before committing', async () => {
        for (const change of [{ sourceHash: 'b'.repeat(64) }, { sourceSize: IMPORT_SIZE + 1 }, { sourceFormat: 'iges' as const }]) {
            const harness = importHarness();
            const proposalId = await previewedImportProposal(harness);
            harness.service.inspectImportSource.mockResolvedValueOnce({
                ...IMPORT_INSPECTION,
                sourcePath: IMPORT_PATH,
                ...change
            });

            const result = await applyImport(harness, proposalId);

            expect(result).toMatchObject({ ok: false, message: expect.stringContaining('changed after this preview') });
            expect(harness.imports).toHaveLength(0);
            expect(harness.proposals.get(proposalId)).toBeDefined();
        }
    });

    it('rejects an apply-time source that became a symlink or exceeded the size cap', async () => {
        const cases = [
            { entry: { isFile: true, isSymbolicLink: true, size: IMPORT_SIZE }, message: /symbolic link/ },
            { entry: { isFile: true, size: MAX_IMPORT_SOURCE_BYTES + 1 }, message: /256 MiB/ }
        ];

        for (const change of cases) {
            const harness = importHarness();
            const proposalId = await previewedImportProposal(harness);
            const inspectedBefore = harness.service.inspectImportSource.mock.calls.length;
            harness.filesystem.set(IMPORT_PATH, {
                ...harness.filesystem.get(IMPORT_PATH)!,
                ...change.entry
            });

            const result = await applyImport(harness, proposalId);

            expect(result).toMatchObject({ ok: false, message: expect.stringMatching(change.message) });
            expect(harness.service.inspectImportSource).toHaveBeenCalledTimes(inspectedBefore);
            expect(harness.imports).toHaveLength(0);
            expect(harness.proposals.get(proposalId)).toBeDefined();
        }
    });

    it('rejects a stale import proposal after revision or epoch changes', async () => {
        const revision = importHarness();
        const revisionProposal = await previewedImportProposal(revision);
        revision.bumpRevision();
        expect(await applyImport(revision, revisionProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(revision.imports).toHaveLength(0);

        const epoch = importHarness();
        const epochProposal = await previewedImportProposal(epoch);
        epoch.bumpEpoch();
        expect(await applyImport(epoch, epochProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(epoch.imports).toHaveLength(0);
    });

    it('rejects apply when body names change the re-planned drafts', async () => {
        const harness = importHarness();
        const proposalId = await previewedImportProposal(harness);
        harness.currentDocument().bodies.push({ id: 'body-existing', name: 'fuel' });

        const result = await applyImport(harness, proposalId);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('plan changed') });
        expect(harness.imports).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();
    });

    it('undoes an import through store.undo, clears selection, and rebuilds', async () => {
        const harness = importHarness();
        const proposalId = await previewedImportProposal(harness);
        await applyImport(harness, proposalId);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true, message: 'CAD import undone.' });
        expect(harness.undoCalls).toBe(1);
        expect(harness.selections).toEqual([undefined]);
        expect(harness.commands.filter((command) => command === 'nuke.cad.rebuild')).toHaveLength(2);
        expect(harness.currentDocument().bodies.map((body) => body.name)).toEqual(['Body 1']);
        expect(harness.currentDocument().features.filter((feature) => feature.type === 'import')).toHaveLength(0);
    });

    it('rejects import undo after the applied revision changes', async () => {
        const harness = importHarness();
        const proposalId = await previewedImportProposal(harness);
        await applyImport(harness, proposalId);
        harness.bumpRevision();

        expect(await harness.undoEntries[0].undo()).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this edit')
        });
        expect(harness.undoCalls).toBe(0);
        expect(harness.selections).toHaveLength(0);
    });

    it('keeps feature, sketch, topology, and import applies separate', async () => {
        const harness = importHarness();
        const proposalId = await previewedImportProposal(harness);

        expect(await apply(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('import')
        });
        expect(await applySketch(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('import')
        });
        expect(await applyTopology(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('import')
        });
        expect(harness.imports).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();
    });

    it('summarizes assembly instances, matrices, solid ids, BOM, and grounding without the kill switch', async () => {
        const harness = assemblyHarness({ enabled: false });
        const capability = harness.registered.get(SUMMARIZE_ASSEMBLY_ID)!;

        expect(capability.when!(CONTEXT)).toBe(true);
        const result = await summarizeAssembly(harness);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            hasAssembly: true,
            groundedInstanceId: 'base',
            overlapCheck: true,
            instances: [
                {
                    id: 'base',
                    part: 'body:body-base',
                    solidIds: [1],
                    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                },
                {
                    id: 'arm',
                    part: 'body:body-arm',
                    solidIds: [2],
                    matrix: [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                }
            ],
            bom: [
                { part: 'body:body-arm', before: 1, after: 1, delta: 0 },
                { part: 'body:body-base', before: 1, after: 1, delta: 0 }
            ],
            connectors: [],
            mates: [],
            warnings: []
        });
        expect(harness.preferences.get).not.toHaveBeenCalled();
    });

    it('warns when the active document has no assembly', async () => {
        const harness = createHarness({ enabled: false });
        const result = await summarizeAssembly(harness);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            hasAssembly: false,
            groundedInstanceId: '',
            instances: [],
            warnings: ['This document has no assembly section.']
        });
    });

    it('gates assembly preview and apply but keeps summarize available with an open document', async () => {
        const disabled = assemblyHarness({ enabled: false });
        expect(disabled.registered.get(SUMMARIZE_ASSEMBLY_ID)!.when!(CONTEXT)).toBe(true);
        for (const id of [PREVIEW_ASSEMBLY_CHANGE_ID, APPLY_ASSEMBLY_CHANGE_ID]) {
            expect(disabled.registered.get(id)!.when!(CONTEXT)).toBe(false);
        }
        expect(await previewAssembly(disabled)).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
        expect(disabled.service.buildDocument).not.toHaveBeenCalled();

        const unsaved = assemblyHarness({ saved: false });
        expect(await previewAssembly(unsaved)).toMatchObject({ ok: false, message: expect.stringContaining('Open a saved') });
        const noModel = assemblyHarness({ hasModel: false });
        expect(await previewAssembly(noModel)).toMatchObject({ ok: false, message: expect.stringContaining('Open a saved') });

        const noDocument = createHarness({ document: createDocument(), enabled: false });
        noDocument.registered.get(SUMMARIZE_ASSEMBLY_ID)!.when!(CONTEXT);
        expect(await summarizeAssembly(noDocument)).toMatchObject({ ok: true });
    });

    it('rejects an ungrounded assembly before planning or building', async () => {
        const document = createAssemblyDocument();
        document.assembly!.groundedInstanceId = '';
        const harness = assemblyHarness({ document });

        expect(await previewAssembly(harness)).toMatchObject({
            ok: false,
            message: expect.stringContaining('grounded assembly')
        });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.proposals.list()).toHaveLength(0);
    });

    it('previews a placement with solved transforms, BOM delta, collisions, ghost, and review panel', async () => {
        const harness = assemblyHarness({
            build: { ...ASSEMBLY_BUILD_PLACED, warnings: ["Assembly instances 'arm' and 'base' overlap by 0.5 mm."] }
        });
        stubAssemblyTessellation(harness);

        const result = await previewAssembly(harness);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            title: 'CAD assembly change',
            applyCapability: APPLY_ASSEMBLY_CHANGE_ID
        });
        expect(result.data).toMatchObject({
            summary: "Move instance 'arm'",
            impact: { solids: { before: 2, after: 2 } },
            assembly: {
                before: {
                    instances: [
                        { id: 'base', placement: { position: [0, 0, 0] } },
                        { id: 'arm', placement: { position: [20, 0, 0] } }
                    ],
                    groundedInstanceId: 'base'
                },
                after: {
                    instances: [
                        { id: 'base', placement: { position: [0, 0, 0] } },
                        { id: 'arm', placement: { position: [30, 0, 0] } }
                    ],
                    groundedInstanceId: 'base'
                },
                placements: [{ instanceId: 'arm', kind: 'place' }],
                bomDelta: { beforeTotal: 2, afterTotal: 2, groundedBefore: 'base', groundedAfter: 'base' },
                collisionWarnings: ["Assembly instances 'arm' and 'base' overlap by 0.5 mm."],
                overlapCheck: true,
                requiresAcknowledgement: false,
                openmcStatus: 'no-saved-project'
            }
        });
        expect(result.warnings).toEqual(
            expect.arrayContaining([
                "Assembly instances 'arm' and 'base' overlap by 0.5 mm.",
                expect.stringContaining('No saved OpenMC project')
            ])
        );
        expect(harness.ghostPreview.show).toHaveBeenCalledWith(
            expect.objectContaining({ tessData: ASSEMBLY_PARSED_TESS, addedSolidIds: [], removedSolidIds: [] })
        );
        expect(harness.commands).toContain('nuke.cad.openReviewPanel');
        expect(harness.assemblyChanges).toHaveLength(0);
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isAssemblyProposal(proposal)) {
            throw new Error('expected an assembly proposal');
        }
        expect(proposal.applyCapability).toBe(APPLY_ASSEMBLY_CHANGE_ID);
        expect(proposal.assembly.placements[0].before?.solidIds).toEqual([2]);
        expect(proposal.assembly.placements[0].after?.solidIds).toEqual([2]);
        expect(proposal.assembly.placements[0].after?.matrix).toEqual([1, 0, 0, 30, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });

    it('reports disabled overlap checks and adds no acknowledgement for a placement', async () => {
        const document = createAssemblyDocument();
        document.overlapCheck = false;
        const harness = assemblyHarness({ document });

        const result = await previewAssembly(harness);

        expect(result.ok).toBe(true);
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isAssemblyProposal(proposal)) {
            throw new Error('expected an assembly proposal');
        }
        expect(proposal.assembly.overlapCheck).toBe(false);
        expect(proposal.assembly.collisionWarnings).toContain('Instance overlap checks are disabled for this document.');
        expect(proposal.assembly.requiresAcknowledgement).toBe(false);
    });

    it('requires acknowledgement only when a removal loses the last labelled instance', async () => {
        const harness = assemblyHarness({ build: ASSEMBLY_BUILD_REMOVED });
        stubAssemblyTessellation(harness);

        const result = await previewAssembly(harness, { changes: [REMOVE_ARM] });

        expect(result.ok).toBe(true);
        const data = result.data as { proposalId: string; assembly: NukeCadAssemblyProposalDetails };
        expect(data.assembly.requiresAcknowledgement).toBe(true);
        expect(data.assembly.removedSelectorKeys).toEqual(['arm/arm-solid']);
        expect(data.assembly.removedRegions).toEqual([{ selector: 'arm-solid', group: 'arm-solid', solidIds: [2] }]);
        expect(data.assembly.bomDelta.rows).toEqual([
            { part: 'body:body-arm', before: 1, after: 0, delta: -1 },
            { part: 'body:body-base', before: 1, after: 1, delta: 0 }
        ]);
        expect(result.changeSet?.applyCapability).toBe(APPLY_ASSEMBLY_CHANGE_ID);
        const proposal = harness.proposals.get(data.proposalId)!;
        if (!isAssemblyProposal(proposal)) {
            throw new Error('expected an assembly proposal');
        }
        expect(proposal.assembly.blockedRegions).toEqual([]);
        expect(harness.ghostPreview.show).toHaveBeenCalledTimes(1);
    });

    it('drops the apply action when a removal breaks a saved OpenMC group', async () => {
        const harness = assemblyHarness({
            build: ASSEMBLY_BUILD_REMOVED,
            files: { [ASSEMBLY_OPENMC_PROJECT_PATH]: ASSEMBLY_OPENMC_PROJECT_JSON }
        });

        const result = await previewAssembly(harness, { changes: [REMOVE_ARM] }, ASSEMBLY_OPENMC_CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.changeSet?.applyCapability).toBeUndefined();
        const data = result.data as {
            proposalId: string;
            assembly: NukeCadAssemblyProposalDetails;
            blockedRegions: readonly { reference: string }[];
        };
        expect(data.blockedRegions).toHaveLength(1);
        expect(data.blockedRegions[0].reference).toBe('arm-solid');
        const proposal = harness.proposals.get(data.proposalId)!;
        if (!isAssemblyProposal(proposal)) {
            throw new Error('expected an assembly proposal');
        }
        expect(proposal.assembly.blockedRegions[0].message).toContain('arm-solid');
        expect(proposal.assembly.openmcStatus).toBe('saved-project');
    });

    it('adds an instance without acknowledgement and validates its expected labelled selector', async () => {
        const harness = assemblyHarness({ build: ASSEMBLY_BUILD_ADDED });

        const result = await previewAssembly(harness, { changes: [ADD_ARM2] });

        expect(result.ok).toBe(true);
        const data = result.data as { proposalId: string; assembly: NukeCadAssemblyProposalDetails };
        expect(data.assembly.requiresAcknowledgement).toBe(false);
        expect(data.assembly.after.instances.map((instance) => instance.id)).toEqual(['base', 'arm', 'arm2']);
        expect(data.assembly.bomDelta.rows).toEqual([
            { part: 'body:body-arm', before: 1, after: 2, delta: 1 },
            { part: 'body:body-base', before: 1, after: 1, delta: 0 }
        ]);
        expect(result.changeSet?.applyCapability).toBe(APPLY_ASSEMBLY_CHANGE_ID);
    });

    it('validates assembly candidate builds for usability, selector ownership, and expected added keys', () => {
        const document = createAssemblyDocument();
        const before = document.assembly as AssemblySection;
        const addedSection: AssemblySection = {
            ...before,
            instances: [
                ...before.instances,
                { id: 'arm2', part: 'body:body-arm', placement: { position: [40, 0, 0], orientation: [0, 0, 0, 1] } }
            ]
        };

        expect(validateAssemblyCandidateBuild(ASSEMBLY_BUILD_ADDED, addedSection, document)).toBeUndefined();
        expect(validateAssemblyCandidateBuild({ ...ASSEMBLY_BUILD_ADDED, success: false, error: 'boom' }, addedSection, document)).toBe(
            'boom'
        );
        expect(
            validateAssemblyCandidateBuild(
                { ...ASSEMBLY_BUILD_ADDED, featureResults: [{ featureId: 'pad-2', status: 'failed' }] },
                addedSection,
                document
            )
        ).toContain('pad-2');
        expect(validateAssemblyCandidateBuild({ ...ASSEMBLY_BUILD_ADDED, solidCount: 0 }, addedSection, document)).toContain('no solids');
        expect(validateAssemblyCandidateBuild({ ...ASSEMBLY_BUILD_ADDED, triangleCount: 0 }, addedSection, document)).toContain(
            'no tessellation'
        );
        expect(
            validateAssemblyCandidateBuild(
                { ...ASSEMBLY_BUILD_ADDED, boundingBox: { min: [1, 1, 1], max: [1, 1, 1] } },
                addedSection,
                document
            )
        ).toContain('bounding box');
        expect(
            validateAssemblyCandidateBuild(
                { ...ASSEMBLY_BUILD_ADDED, selectorMap: { 'base/base-solid': [1], 'ghost/arm-solid': [2] } },
                addedSection,
                document
            )
        ).toContain('does not belong to a final assembly instance');
        expect(
            validateAssemblyCandidateBuild(
                { ...ASSEMBLY_BUILD_ADDED, selectorMap: { 'base/base-solid': [1], 'arm/arm-solid': [2] } },
                addedSection,
                document
            )
        ).toContain("expected selector 'arm2/arm-solid'");
    });

    it('rejects failed, empty, selector-mismatched, and missing-key preview builds', async () => {
        const failed = assemblyHarness({ build: { ...ASSEMBLY_BUILD_PLACED, success: false, error: 'assembly build failed' } });
        expect(await previewAssembly(failed)).toMatchObject({ ok: false, message: 'assembly build failed' });
        expect(failed.proposals.list()).toHaveLength(0);

        const noSolids = assemblyHarness({ build: { ...ASSEMBLY_BUILD_PLACED, solidCount: 0 } });
        expect(await previewAssembly(noSolids)).toMatchObject({ ok: false, message: expect.stringContaining('no solids') });

        const selector = assemblyHarness({
            build: { ...ASSEMBLY_BUILD_PLACED, selectorMap: { 'base/base-solid': [1], 'ghost/arm-solid': [2] } }
        });
        expect(await previewAssembly(selector)).toMatchObject({
            ok: false,
            message: expect.stringContaining('does not belong to a final assembly instance')
        });

        const missingKey = assemblyHarness({ build: { ...ASSEMBLY_BUILD_ADDED, selectorMap: { 'base/base-solid': [1] } } });
        expect(await previewAssembly(missingKey, { changes: [ADD_ARM2] })).toMatchObject({
            ok: false,
            message: expect.stringContaining("expected selector 'arm2/arm-solid'")
        });
    });

    it('applies a placement as one commit with a backup, rebuild, and undo', async () => {
        const harness = assemblyHarness();
        const proposalId = await previewedAssemblyProposal(harness);

        const result = await applyAssembly(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(result.message).toBe('CAD assembly change applied; rebuild scheduled.');
        expect(result.changeSet).toMatchObject({ id: proposalId, title: 'CAD assembly change' });
        expect(result.changeSet).not.toHaveProperty('applyCapability');
        expect(result.undoToken).toBe('undo-token-1');
        expect(result.data).toMatchObject({
            proposalId,
            documentPath: DOCUMENT_PATH,
            revision: 4,
            backupPath: `${WORKSPACE}/.nuke-ai-backup-pincell.nuke-cad`,
            addedInstanceIds: [],
            removedInstanceIds: [],
            groundedInstanceId: 'base',
            rebuildScheduled: true
        });
        expect(harness.assemblyChanges).toEqual([{ actions: [MOVE_ARM] }]);
        expect(harness.files.has(new URI(`${WORKSPACE}/.nuke-ai-backup-pincell.nuke-cad`).path.toString())).toBe(true);
        expect(harness.commands).toContain('nuke.cad.rebuild');
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
        expect(harness.selectionClears).toBe(0);
    });

    it('requires acknowledgement to remove instances and clears selection after apply', async () => {
        const harness = assemblyHarness({ build: ASSEMBLY_BUILD_REMOVED });
        const proposalId = await previewedAssemblyProposal(harness, { changes: [REMOVE_ARM] });

        expect(await applyAssembly(harness, proposalId, CONTEXT, false)).toMatchObject({
            ok: false,
            message: 'Acknowledge the region impact before applying this assembly change.'
        });
        expect(harness.assemblyChanges).toHaveLength(0);

        const result = await applyAssembly(harness, proposalId, CONTEXT, true);

        expect(result.ok).toBe(true);
        expect(harness.assemblyChanges).toHaveLength(1);
        expect(harness.selections).toContain(undefined);
        expect(harness.selectionClears).toBe(1);
        expect(harness.stateSelections).toBe(1);
        expect(result.data).toMatchObject({ removedInstanceIds: ['arm'], groundedInstanceId: 'base' });
    });

    it('rejects a blocked assembly apply and a changed OpenMC project', async () => {
        const blocked = assemblyHarness({
            build: ASSEMBLY_BUILD_REMOVED,
            files: { [ASSEMBLY_OPENMC_PROJECT_PATH]: ASSEMBLY_OPENMC_PROJECT_JSON }
        });
        const blockedProposal = await previewedAssemblyProposal(blocked, { changes: [REMOVE_ARM] }, ASSEMBLY_OPENMC_CONTEXT);
        expect(await applyAssembly(blocked, blockedProposal, ASSEMBLY_OPENMC_CONTEXT, true)).toMatchObject({
            ok: false,
            message: expect.stringContaining('arm-solid')
        });
        expect(blocked.assemblyChanges).toHaveLength(0);

        const moved = assemblyHarness({ build: ASSEMBLY_BUILD_REMOVED });
        const movedProposal = await previewedAssemblyProposal(moved, { changes: [REMOVE_ARM] }, CONTEXT);
        expect(await applyAssembly(moved, movedProposal, ASSEMBLY_OPENMC_CONTEXT, true)).toMatchObject({
            ok: false,
            message: 'The active OpenMC project changed after this preview. Preview the change again.'
        });
        expect(moved.assemblyChanges).toHaveLength(0);
    });

    it('re-checks a previously clean OpenMC project on apply', async () => {
        const harness = assemblyHarness({ build: ASSEMBLY_BUILD_REMOVED });
        const proposalId = await previewedAssemblyProposal(harness, { changes: [REMOVE_ARM] }, ASSEMBLY_OPENMC_CONTEXT);
        harness.files.set(new URI(ASSEMBLY_OPENMC_PROJECT_PATH).path.toString(), ASSEMBLY_OPENMC_PROJECT_JSON);

        expect(await applyAssembly(harness, proposalId, ASSEMBLY_OPENMC_CONTEXT, true)).toMatchObject({
            ok: false,
            message: expect.stringContaining('arm-solid')
        });
        expect(harness.assemblyChanges).toHaveLength(0);
    });

    it('rejects stale, drifted, or store-rejected assembly applies', async () => {
        const revision = assemblyHarness();
        const revisionProposal = await previewedAssemblyProposal(revision);
        revision.bumpRevision();
        expect(await applyAssembly(revision, revisionProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(revision.assemblyChanges).toHaveLength(0);

        const drifted = assemblyHarness();
        const driftedProposal = await previewedAssemblyProposal(drifted);
        drifted.currentDocument().assembly!.groundedInstanceId = 'arm';
        expect(await applyAssembly(drifted, driftedProposal)).toMatchObject({
            ok: false,
            message: 'The assembly changed after this preview. Preview the change again.'
        });
        expect(drifted.assemblyChanges).toHaveLength(0);

        const rejected = assemblyHarness({ assemblyApplySucceeds: false });
        const rejectedProposal = await previewedAssemblyProposal(rejected);
        expect(await applyAssembly(rejected, rejectedProposal)).toMatchObject({
            ok: false,
            message: 'The CAD document rejected the assembly change.'
        });
        expect(rejected.undoEntries).toHaveLength(0);
    });

    it('undoes an assembly change through store.undo, clears selection, and rebuilds', async () => {
        const harness = assemblyHarness({ build: ASSEMBLY_BUILD_REMOVED });
        const proposalId = await previewedAssemblyProposal(harness, { changes: [REMOVE_ARM] });
        await applyAssembly(harness, proposalId, CONTEXT, true);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true, message: 'CAD assembly change undone.' });
        expect(harness.undoCalls).toBe(1);
        expect(harness.selections).toEqual([undefined, undefined]);
        expect(harness.selectionClears).toBe(2);
        expect(harness.stateSelections).toBe(2);
        expect(harness.commands.filter((command) => command === 'nuke.cad.rebuild')).toHaveLength(2);
        expect(harness.currentDocument().assembly!.instances.map((instance) => instance.id)).toEqual(['base', 'arm']);
    });

    it('rejects assembly undo after the applied revision changes', async () => {
        const harness = assemblyHarness();
        const proposalId = await previewedAssemblyProposal(harness);
        await applyAssembly(harness, proposalId);
        harness.bumpRevision();

        expect(await harness.undoEntries[0].undo()).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this edit')
        });
        expect(harness.undoCalls).toBe(0);
    });

    it('keeps assembly applies separate from every other scope', async () => {
        const harness = assemblyHarness();
        const proposalId = await previewedAssemblyProposal(harness);

        for (const result of [
            await apply(harness, proposalId),
            await applySketch(harness, proposalId),
            await applyTopology(harness, proposalId),
            await applyImport(harness, proposalId)
        ]) {
            expect(result).toMatchObject({ ok: false, message: expect.stringContaining('assembly change') });
        }
        expect(harness.assemblyChanges).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();

        const featureHarness = createHarness();
        const featurePreview = await preview(featureHarness);
        const featureProposalId = (featurePreview.data as { proposalId: string }).proposalId;
        expect(await applyAssembly(featureHarness, featureProposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('feature change')
        });
    });

    it('summarizes drawing sheets, views, dimensions, and title block with authoring off', async () => {
        const harness = drawingHarness({ enabled: false });
        const result = await summarizeDrawing(harness);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            hasDrawings: true,
            drawingVersion: 1,
            sheets: [
                {
                    id: 'sheet-1',
                    name: 'Sheet 1',
                    size: 'A4',
                    orientation: 'landscape',
                    sheetSizeMm: { width: 297, height: 210 },
                    scaleLabel: '1:1'
                }
            ],
            views: [
                {
                    sheetId: 'sheet-1',
                    id: 'view-front',
                    kind: 'base',
                    orientation: 'front',
                    scale: 1,
                    scaleLabel: '1:1',
                    position: [120, 120],
                    showHidden: false
                }
            ],
            dimensions: [
                {
                    sheetId: 'sheet-1',
                    id: 'dim-1',
                    kind: 'distance',
                    viewId: 'view-front',
                    visible: true,
                    value: 10,
                    stale: false,
                    targetFeatureIds: ['hole-1', 'pattern-1'],
                    targetKinds: ['edge']
                }
            ],
            titleBlock: {
                editable: false,
                fields: {
                    documentName: 'pincell',
                    sheetName: 'Sheet 1',
                    size: 'A4',
                    orientation: 'landscape',
                    scaleLabel: '1:1',
                    brand: 'NUKE CAD',
                    product: 'NukeIDE'
                }
            },
            warnings: []
        });
    });

    it('summarizes an empty document and reports failed-build and drawing warnings', async () => {
        const empty = createHarness({ enabled: false, modelResult: { ...BUILD_RESULT, success: false } });
        const emptyResult = await summarizeDrawing(empty);
        expect(emptyResult.ok).toBe(true);
        expect(emptyResult.data).toMatchObject({
            hasDrawings: false,
            sheets: [],
            views: [],
            dimensions: [],
            warnings: expect.arrayContaining([
                expect.stringContaining('no drawing sheets'),
                expect.stringContaining('active CAD build failed')
            ])
        });
        expect(emptyResult.data).toMatchObject({
            titleBlock: {
                editable: false,
                fields: { documentName: 'pincell', sheetName: '', size: 'A4', orientation: 'landscape' }
            }
        });

        const harness = drawingHarness({ enabled: false });
        const sheet = harness.currentDocument().drawings![0];
        sheet.views[0].position = [500, 500];
        sheet.dimensions[0].stale = true;
        const result = await summarizeDrawing(harness);
        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            views: [expect.objectContaining({ position: [500, 500] })],
            dimensions: [expect.objectContaining({ stale: true })],
            warnings: expect.arrayContaining([
                expect.stringContaining("View 'view-front' lies outside"),
                expect.stringContaining('Stale drawing dimension(s): dim-1')
            ])
        });

        const emptySheetHarness = drawingHarness({ enabled: false });
        emptySheetHarness.currentDocument().drawings![0].views = [];
        emptySheetHarness.currentDocument().drawings![0].dimensions = [];
        const emptySheetResult = await summarizeDrawing(emptySheetHarness);
        expect(emptySheetResult.data).toMatchObject({
            sheets: [expect.objectContaining({ scaleLabel: '—' })],
            warnings: expect.arrayContaining([expect.stringContaining("sheet 'Sheet 1' has no views")])
        });
    });

    it('gates drawing previews on authoring, a saved active document, and a valid plan', async () => {
        expect(await previewDrawing(drawingHarness({ enabled: false }))).toMatchObject({
            ok: false,
            message: expect.stringContaining('CAD AI authoring is disabled')
        });
        expect(await previewDrawing(drawingHarness({ saved: false }))).toMatchObject({
            ok: false,
            message: expect.stringContaining('Open a saved .nuke-cad document')
        });
        expect(await previewDrawing(drawingHarness({ hasModel: false }))).toMatchObject({
            ok: false,
            message: expect.stringContaining('Open a saved .nuke-cad document')
        });
        expect(await previewDrawing(drawingHarness(), { changes: [] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('1 to 16')
        });
        expect(
            await previewDrawing(drawingHarness(), { changes: [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A4' }] })
        ).toMatchObject({
            ok: false,
            message: expect.stringContaining('already A4')
        });
    });

    it('previews a drawing change without building, ghosting, or writing', async () => {
        const harness = drawingHarness();
        const result = await previewDrawing(harness);

        expect(result.ok).toBe(true);
        const data = result.data as { proposalId: string; summary: string; drawing: unknown };
        expect(data.summary).toBe(
            "Sheet 'Sheet 1' A4 → A3; base front view: scale 1:1 → 1:2, hidden lines on; Hide distance dimension 'dim-1'"
        );
        expect(result.changeSet).toMatchObject({
            title: 'CAD drawing change',
            applyCapability: 'nuke.cad.applyDrawingChange'
        });
        expect(data.drawing).toMatchObject({
            sheet: { id: 'sheet-1', name: 'Sheet 1', sizeBefore: 'A4', sizeAfter: 'A3' },
            viewChanges: [
                {
                    id: 'view-front',
                    kind: 'base',
                    orientation: 'front',
                    scaleBefore: 1,
                    scaleAfter: 0.5,
                    showHiddenBefore: false,
                    showHiddenAfter: true
                }
            ],
            dimensionChanges: [{ id: 'dim-1', kind: 'distance', viewId: 'view-front', visibleBefore: true, visibleAfter: false }],
            titleBlockEditable: false,
            requiresDrawingRefresh: true,
            warnings: []
        });
        expect(result).not.toHaveProperty('preview');

        const proposal = harness.proposals.get(data.proposalId);
        expect(proposal?.scope).toBe('drawing');
        expect(isDrawingProposal(proposal!)).toBe(true);
        expect(proposal).not.toHaveProperty('impact');
        expect(proposal).not.toHaveProperty('build');

        expect(harness.commands).toEqual(['nuke.cad.openReviewPanel']);
        expect(harness.ghostPreview.clear).toHaveBeenCalledTimes(1);
        expect(harness.ghostPreview.show).not.toHaveBeenCalled();
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.fileService.create).not.toHaveBeenCalled();
        expect(harness.fileService.delete).not.toHaveBeenCalled();
    });

    it('applies a drawing change once, backs up, opens and refreshes the sheet, and never rebuilds', async () => {
        const harness = drawingHarness();
        const proposalId = await previewedDrawingProposal(harness);
        const result = await applyDrawing(harness, proposalId);

        const backupPath = `${WORKSPACE}/.nuke-ai-backup-pincell.nuke-cad`;
        expect(result.ok).toBe(true);
        expect(result.message).toContain('drawing refresh scheduled');
        expect(result.data).toMatchObject({
            proposalId,
            sheetId: 'sheet-1',
            revision: 4,
            backupPath,
            drawingRefreshScheduled: true,
            geometryRebuildScheduled: false,
            changes: expect.any(Array)
        });
        expect(result.changeSet).toMatchObject({ title: 'CAD drawing change' });
        expect(result.changeSet).not.toHaveProperty('applyCapability');
        expect(result.undoToken).toBe('undo-token-1');

        expect(harness.drawingChanges).toHaveLength(1);
        expect(harness.drawingChanges[0].actions).toEqual(DRAWING_ACTIONS);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
        expect(harness.drawingVersion()).toBe(2);

        const backup = JSON.parse(harness.files.get(backupPath)!) as NukeCadDocument;
        expect(backup.drawings?.[0].size).toBe('A4');
        expect(backup.drawings?.[0].views[0].scale).toBe(1);

        expect(harness.commands).toEqual(['nuke.cad.openReviewPanel', 'nuke.cad.openDrawingSheet', 'nuke.cad.refreshDrawingSheet']);
        expect(harness.commandCalls[2].args).toEqual(['sheet-1']);
        expect(harness.commands).not.toContain('nuke.cad.rebuild');
        expect(harness.service.buildDocument).not.toHaveBeenCalled();

        const sheet = harness.currentDocument().drawings![0];
        expect(sheet.size).toBe('A3');
        expect(sheet.views[0]).toMatchObject({ scale: 0.5, showHidden: true });
        expect(sheet.dimensions[0].hidden).toBe(true);
        expect(harness.undoEntries[0].title).toBe('CAD drawing change');
    });

    it('rejects drawing applies after a revision or epoch change', async () => {
        const revisionHarness = drawingHarness();
        const revisionProposal = await previewedDrawingProposal(revisionHarness);
        revisionHarness.bumpRevision();
        expect(await applyDrawing(revisionHarness, revisionProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(revisionHarness.drawingChanges).toHaveLength(0);

        const epochHarness = drawingHarness();
        const epochProposal = await previewedDrawingProposal(epochHarness);
        epochHarness.bumpEpoch();
        expect(await applyDrawing(epochHarness, epochProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('active document changed')
        });
        expect(epochHarness.drawingChanges).toHaveLength(0);
    });

    it('rejects a drawing apply when the re-planned sheet rows drift', async () => {
        const harness = drawingHarness();
        const proposalId = await previewedDrawingProposal(harness);
        harness.currentDocument().drawings![0].name = 'Renamed sheet';

        expect(await applyDrawing(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('drawing changed after this preview')
        });
        expect(harness.drawingChanges).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();
    });

    it('rejects a drawing proposal from every other apply capability and rejects other scopes here', async () => {
        const harness = drawingHarness();
        const proposalId = await previewedDrawingProposal(harness);

        for (const result of [
            await apply(harness, proposalId),
            await applySketch(harness, proposalId),
            await applyTopology(harness, proposalId),
            await applyImport(harness, proposalId),
            await applyAssembly(harness, proposalId)
        ]) {
            expect(result).toMatchObject({ ok: false, message: expect.stringContaining('drawing change') });
        }
        expect(harness.drawingChanges).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();

        const featureHarness = createHarness();
        const featurePreview = await preview(featureHarness);
        const featureProposalId = (featurePreview.data as { proposalId: string }).proposalId;
        expect(await applyDrawing(featureHarness, featureProposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('feature change')
        });
    });

    it('undoes a drawing change through the store and refreshes the sheet without rebuilding', async () => {
        const harness = drawingHarness();
        const proposalId = await previewedDrawingProposal(harness);
        await applyDrawing(harness, proposalId);

        const result = await harness.undoEntries[0].undo();
        expect(result).toMatchObject({ ok: true, message: 'CAD drawing change undone.' });
        expect(harness.undoCalls).toBe(1);
        expect(harness.drawingVersion()).toBe(3);
        expect(harness.currentDocument().drawings![0]).toMatchObject({ size: 'A4' });
        expect(harness.currentDocument().drawings![0].views[0]).toMatchObject({ scale: 1 });
        expect(harness.currentDocument().drawings![0].dimensions[0].hidden).toBeUndefined();

        expect(harness.commands).toEqual([
            'nuke.cad.openReviewPanel',
            'nuke.cad.openDrawingSheet',
            'nuke.cad.refreshDrawingSheet',
            'nuke.cad.openDrawingSheet',
            'nuke.cad.refreshDrawingSheet'
        ]);
        expect(harness.commandCalls[4].args).toEqual(['sheet-1']);
        expect(harness.commands).not.toContain('nuke.cad.rebuild');
    });

    it('rejects drawing undo after the applied revision changes', async () => {
        const harness = drawingHarness();
        const proposalId = await previewedDrawingProposal(harness);
        await applyDrawing(harness, proposalId);
        harness.bumpRevision();

        expect(await harness.undoEntries[0].undo()).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this edit')
        });
        expect(harness.undoCalls).toBe(0);
    });
});

describe('NukeCadAuthoringCapabilities script authoring', () => {
    it('inspects the active script with its hash, imports, and sandbox status', async () => {
        const harness = scriptHarness();

        const result = await inspectScript(harness);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            path: SCRIPT_PATH,
            hash: await hashScriptContent(SCRIPT_BASE_CONTENT),
            content: SCRIPT_BASE_CONTENT,
            bytes: new TextEncoder().encode(SCRIPT_BASE_CONTENT).byteLength,
            lines: 2,
            imports: ['from build123d import *'],
            hasModelAssignment: true,
            truncated: false,
            sandbox: { available: true, engine: 'bubblewrap', version: '0.8.0', disableUserns: true }
        });
        expect(harness.sandboxStatusCalls).toBe(1);
        expect(harness.service.buildSandboxedScript).not.toHaveBeenCalled();
        expect(harness.auditRecords).toEqual([]);
    });

    it('gates inspection on both authoring switches, an active .py model, and sandbox availability', async () => {
        const aiOff = await inspectScript(scriptHarness({ enabled: false }));
        expect(aiOff).toMatchObject({ ok: false, message: expect.stringContaining('CAD AI authoring is disabled') });

        const scriptOff = await inspectScript(scriptHarness({ scriptAuthoring: false }));
        expect(scriptOff).toMatchObject({ ok: false, message: expect.stringContaining('script AI authoring is disabled') });

        const documentModel = await inspectScript(createHarness());
        expect(documentModel).toMatchObject({
            ok: false,
            message: expect.stringContaining('Open an active Python (.py) CAD model script')
        });

        const noModel = await inspectScript(scriptHarness({ hasModel: false }));
        expect(noModel).toMatchObject({ ok: false, message: expect.stringContaining('Open an active Python (.py) CAD model script') });

        const unavailable = await inspectScript(
            scriptHarness({ sandboxStatus: { available: false, engine: 'bubblewrap', reason: 'No user namespaces.' } })
        );
        expect(unavailable).toMatchObject({
            ok: false,
            message: expect.stringContaining('no unsandboxed fallback')
        });
        expect((unavailable as { message: string }).message).toContain('No user namespaces.');

        const previewUnavailable = await previewScript(
            scriptHarness({ sandboxStatus: { available: false, engine: 'bubblewrap', reason: 'No user namespaces.' } }),
            await scriptPreviewInput()
        );
        expect(previewUnavailable).toMatchObject({
            ok: false,
            message: expect.stringContaining('no unsandboxed fallback')
        });
    });

    it('previews in a staging directory without writing the source and opens the review panel without a ghost', async () => {
        const harness = scriptHarness();
        const input = await scriptPreviewInput({ summary: 'Resize the pincell box' });

        const result = await previewScript(harness, input);

        expect(result.ok).toBe(true);
        const data = result.data as {
            proposalId: string;
            summary: string;
            diff: { text: string; truncated: boolean; addedLines: number; removedLines: number; hunkCount: number };
            imports: string[];
            build: { success: boolean; solidCount: number; faceCount: number; triangleCount: number };
            sandbox: { available: boolean };
            auditId: string;
            warnings: string[];
            approvalId?: string;
        };
        expect(data.summary).toBe('Resize the pincell box');
        expect(data.diff).toMatchObject({ truncated: false, addedLines: 1, removedLines: 1, hunkCount: 1 });
        expect(data.diff.text).toContain('-model = Box(1, 2, 3)');
        expect(data.diff.text).toContain('+model = Box(2, 2, 2)');
        expect(data.imports).toEqual(['from build123d import *']);
        expect(data.build).toMatchObject({ success: true, solidCount: 1, faceCount: 6, triangleCount: 12 });
        expect(data.sandbox).toMatchObject({ available: true });
        expect(data.auditId).toMatch(/^[0-9a-f-]{36}$/);
        expect(data.warnings).toEqual([]);
        expect(data).not.toHaveProperty('approvalId');
        expect(JSON.stringify(data)).not.toContain('approvalId');
        expect(result.changeSet).toMatchObject({ id: data.proposalId, title: 'CAD script change', summary: 'Resize the pincell box' });
        expect(result.changeSet).not.toHaveProperty('applyCapability');

        const proposal = scriptProposal(harness, data.proposalId);
        expect(proposal.script.baseScriptHash).toBe(await hashScriptContent(SCRIPT_BASE_CONTENT));
        expect(proposal.script.proposedScriptHash).toBe(await hashScriptContent(SCRIPT_PROPOSED_CONTENT));
        expect(proposal.script.proposedScript).toBe(SCRIPT_PROPOSED_CONTENT);
        expect(proposal.script.approvalId).toMatch(/^[0-9a-f-]{36}$/);
        expect(proposal.applyCapability).toBe('nuke.cad.applyScriptChange');

        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
        expect(harness.scriptBuilds).toHaveLength(1);
        const build = harness.scriptBuilds[0];
        expect(build.scriptPath).toMatch(/\/\.nuke-ide\/ai\/cad-scripts\/[0-9a-f-]+\/model\.py$/);
        expect(build.workspaceRoot).toBe(WORKSPACE);
        expect(build.outputDirectory).toMatch(/\/\.nuke-ide\/ai\/cad-scripts\/[0-9a-f-]+\/out$/);
        expect(build.tolerance).toBe(0.1);
        expect(build.timeoutSeconds).toBe(120);
        expect(build.memoryLimitMb).toBe(4096);
        expect(build.processLimit).toBe(128);
        expect(build.fileSizeLimitMb).toBe(512);
        expect(build.jobId).toMatch(/^cad-ai-script-preview-/);
        expect([...harness.files.keys()].some((filePath) => filePath.includes('/.nuke-ide/ai/cad-scripts/'))).toBe(false);

        expect(harness.ghostPreview.clear).toHaveBeenCalledTimes(1);
        expect(harness.ghostPreview.show).not.toHaveBeenCalled();
        expect(harness.commands).toEqual(['nuke.cad.openReviewPanel']);
        expect(harness.auditRecords).toHaveLength(1);
        expect(harness.auditRecords[0]).toMatchObject({
            capabilityId: 'nuke.cad.previewScriptChange',
            outcome: 'preview-ok',
            baseHash: await hashScriptContent(SCRIPT_BASE_CONTENT),
            proposedHash: await hashScriptContent(SCRIPT_PROPOSED_CONTENT),
            solidCount: 1,
            limits: { timeoutSeconds: 120, memoryMb: 4096, processLimit: 128, fileSizeMb: 512 }
        });
        expect(JSON.stringify(harness.auditRecords[0])).not.toContain('Box(');
        expect(JSON.stringify(harness.auditRecords[0])).not.toContain(SCRIPT_PATH);
    });

    it('rejects a stale base hash, an unchanged body, and an oversized body before building', async () => {
        const harness = scriptHarness();

        const stale = await previewScript(harness, await scriptPreviewInput({ baseScriptHash: 'a'.repeat(64) }));
        expect(stale).toMatchObject({ ok: false, message: expect.stringContaining('changed after it was inspected') });

        const unchanged = await previewScript(harness, await scriptPreviewInput({ proposedScript: SCRIPT_BASE_CONTENT }));
        expect(unchanged).toMatchObject({ ok: false, message: expect.stringContaining('does not change') });

        const oversized = await previewScript(
            harness,
            await scriptPreviewInput({ proposedScript: `${SCRIPT_BASE_CONTENT}${'#'.repeat(64 * 1024)}\n` })
        );
        expect(oversized).toMatchObject({ ok: false, message: expect.stringContaining('64 KiB') });
        expect(harness.scriptBuilds).toEqual([]);
        expect(harness.proposals.list()).toEqual([]);
    });

    it('rejects a preview with no solids and cleans the staging directory', async () => {
        const harness = scriptHarness({ sandboxBuild: { ...SCRIPT_SANDBOX_RESULT, solidCount: 0 } });

        const result = await previewScript(harness, await scriptPreviewInput());

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('produced no solids') });
        expect(harness.proposals.list()).toEqual([]);
        expect(harness.auditRecords.at(-1)).toMatchObject({ capabilityId: 'nuke.cad.previewScriptChange', outcome: 'preview-failed' });
        expect([...harness.files.keys()].some((filePath) => filePath.includes('/.nuke-ide/ai/cad-scripts/'))).toBe(false);
    });

    it('records a timed-out preview as a timeout without leaving staging behind', async () => {
        const harness = scriptHarness({
            sandboxBuild: { success: false, error: 'The script timed out.', timedOut: true, exitCode: null, durationMs: 120000 }
        });

        const result = await previewScript(harness, await scriptPreviewInput());

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('timed out') });
        expect(harness.auditRecords.at(-1)).toMatchObject({ outcome: 'timeout', timedOut: true });
        expect([...harness.files.keys()].some((filePath) => filePath.includes('/.nuke-ide/ai/cad-scripts/'))).toBe(false);
    });

    it('requires a panel nonce that matches the stored script proposal', async () => {
        const harness = scriptHarness();
        const { proposalId } = await previewedScript(harness);

        const missing = await harness.registered.get(APPLY_SCRIPT_CHANGE_ID)!.invoke({ proposalId }, SCRIPT_CONTEXT);
        expect(missing).toMatchObject({ ok: false, message: expect.stringContaining('approvalId is required') });

        const wrong = await applyScript(harness, proposalId, 'f'.repeat(64));
        expect(wrong).toMatchObject({ ok: false, message: expect.stringContaining('does not match the preview') });
        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
        expect(harness.scriptBuilds).toHaveLength(1);
    });

    it('rejects applying a non-script proposal with the script scope message', async () => {
        const harness = scriptHarness();
        const foreign = harness.proposals.create({
            scope: 'features',
            summary: 'Feature change',
            documentPath: SCRIPT_PATH,
            documentEpoch: 0,
            baseRevision: 0,
            changes: [],
            edits: [],
            before: {},
            after: {}
        });

        const result = await applyScript(harness, foreign.id, 'nonce');

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('apply it with nuke.cad.applyFeatureChange') });
        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
    });

    it('rejects a dirty Monaco buffer before writing anything', async () => {
        const harness = scriptHarness({ monacoDirty: true });
        const { proposalId, approvalId } = await previewedScript(harness);

        const result = await applyScript(harness, proposalId, approvalId);

        expect(result).toMatchObject({ ok: false, message: 'Save or close the script editor before applying.' });
        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
    });

    it('rejects apply when the script changed, the active path changed, or the sandbox went away', async () => {
        const staleHarness = scriptHarness();
        const stalePreview = await previewedScript(staleHarness);
        staleHarness.files.set(SCRIPT_PATH, 'model = Box(9, 9, 9)\n');
        expect(await applyScript(staleHarness, stalePreview.proposalId, stalePreview.approvalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(staleHarness.files.get(SCRIPT_PATH)).toBe('model = Box(9, 9, 9)\n');

        const pathHarness = scriptHarness();
        const pathPreview = await previewedScript(pathHarness);
        pathHarness.setStateModel({ ...pathHarness.stateManager.model!, scriptPath: OTHER_SCRIPT_PATH });
        expect(await applyScript(pathHarness, pathPreview.proposalId, pathPreview.approvalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('belongs to a different file')
        });

        const sandboxHarness = scriptHarness();
        const sandboxPreview = await previewedScript(sandboxHarness);
        sandboxHarness.service.getScriptSandboxStatus.mockResolvedValue({
            available: false,
            engine: 'bubblewrap',
            reason: 'bwrap disappeared.'
        });
        expect(await applyScript(sandboxHarness, sandboxPreview.proposalId, sandboxPreview.approvalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('no unsandboxed fallback')
        });
        expect(sandboxHarness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
    });

    it('restores the backup when the written bytes do not match the approved body', async () => {
        const harness = scriptHarness({ corruptNextMove: true });
        const { proposalId, approvalId } = await previewedScript(harness);

        const result = await applyScript(harness, proposalId, approvalId);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('previous script was restored') });
        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
        expect(harness.stateManager.model?.sandboxed).toBeFalsy();
        expect(harness.auditRecords.at(-1)).toMatchObject({ outcome: 'apply-failed' });
        const backupPath = [...harness.files.keys()].find((filePath) => filePath.includes('/.nuke-ide/ai/backups/cad-scripts/'));
        expect(backupPath).toBeDefined();
        expect(harness.files.get(backupPath!)).toBe(SCRIPT_BASE_CONTENT);
    });

    it('restores the backup when the sandbox rejects the applied script', async () => {
        const harness = scriptHarness();
        const { proposalId, approvalId } = await previewedScript(harness);
        harness.service.buildSandboxedScript.mockResolvedValueOnce({
            success: false,
            error: 'The proposed script raised an exception.',
            exitCode: 1,
            durationMs: 500
        });

        const result = await applyScript(harness, proposalId, approvalId);

        expect(result).toMatchObject({
            ok: false,
            message: expect.stringContaining('The proposed script raised an exception. The previous script was restored.')
        });
        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
        expect(harness.stateManager.model?.sandboxed).toBeFalsy();
        expect(harness.proposals.has(proposalId)).toBe(true);
        expect(harness.auditRecords.at(-1)).toMatchObject({ outcome: 'apply-failed' });
    });

    it('applies once, installs a sandboxed model, audits, and registers an undo', async () => {
        const harness = scriptHarness();
        const { proposalId, approvalId } = await previewedScript(harness);
        const baseHash = await hashScriptContent(SCRIPT_BASE_CONTENT);
        const proposedHash = await hashScriptContent(SCRIPT_PROPOSED_CONTENT);

        const result = await applyScript(harness, proposalId, approvalId);

        expect(result.ok).toBe(true);
        const data = result.data as {
            proposalId: string;
            scriptPath: string;
            backupPath: string;
            auditId: string;
            sandboxedBuild: boolean;
            geometryRebuildScheduled: boolean;
            build: { solidCount: number };
        };
        expect(data.proposalId).toBe(proposalId);
        expect(data.scriptPath).toBe(SCRIPT_PATH);
        expect(data.sandboxedBuild).toBe(true);
        expect(data.geometryRebuildScheduled).toBe(false);
        expect(data.build.solidCount).toBe(1);
        expect(data).not.toHaveProperty('approvalId');
        expect(result.changeSet).not.toHaveProperty('approvalId');
        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_PROPOSED_CONTENT);
        expect(harness.files.get(data.backupPath)).toBe(SCRIPT_BASE_CONTENT);
        expect(data.backupPath).toMatch(/\/\.nuke-ide\/ai\/backups\/cad-scripts\/.+-[0-9a-f]{8}-pincell_model\.py$/);
        expect(harness.stateManager.model).toMatchObject({ scriptPath: SCRIPT_PATH, sandboxed: true });
        expect(harness.stateManager.model?.result).toMatchObject({ success: true, solidCount: 1, sandboxed: true });
        expect(harness.proposals.has(proposalId)).toBe(false);
        expect(harness.commands).toEqual(['nuke.cad.openReviewPanel']);
        expect(harness.service.buildSandboxedScript).toHaveBeenCalledTimes(2);
        expect(harness.scriptBuilds[1]).toMatchObject({
            scriptPath: SCRIPT_PATH,
            workspaceRoot: WORKSPACE,
            outputDirectory: `${WORKSPACE}/.nuke-ide/ai/cad-scripts/${proposedHash.slice(0, 8)}/out`,
            timeoutSeconds: 120,
            memoryLimitMb: 4096,
            processLimit: 128,
            fileSizeLimitMb: 512
        });
        expect(harness.auditRecords.map((entry) => entry.outcome)).toEqual(['preview-ok', 'apply-ok']);
        expect(harness.auditRecords.at(-1)).toMatchObject({
            capabilityId: 'nuke.cad.applyScriptChange',
            baseHash,
            proposedHash
        });
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.undoEntries[0].title).toBe('CAD script change');
    });

    it('undoes a script apply by restoring the byte-for-byte backup and rebuilding sandboxed', async () => {
        const harness = scriptHarness();
        const { proposalId, approvalId } = await previewedScript(harness);
        await applyScript(harness, proposalId, approvalId);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true });
        expect(harness.files.get(SCRIPT_PATH)).toBe(SCRIPT_BASE_CONTENT);
        expect(harness.stateManager.model).toMatchObject({ scriptPath: SCRIPT_PATH, sandboxed: true });
        expect(harness.scriptBuilds).toHaveLength(3);
        expect(harness.scriptBuilds[2]).toMatchObject({ scriptPath: SCRIPT_PATH, workspaceRoot: WORKSPACE });
        expect(harness.auditRecords.at(-1)).toMatchObject({
            capabilityId: 'nuke.cad.applyScriptChange',
            outcome: 'undo-ok',
            baseHash: await hashScriptContent(SCRIPT_BASE_CONTENT),
            scriptHash: await hashScriptContent(SCRIPT_PROPOSED_CONTENT)
        });
    });

    it('rejects undo after the script changes or when the backup is missing', async () => {
        const changedHarness = scriptHarness();
        const changedPreview = await previewedScript(changedHarness);
        const applied = await applyScript(changedHarness, changedPreview.proposalId, changedPreview.approvalId);
        changedHarness.files.set(SCRIPT_PATH, 'model = Box(7, 7, 7)\n');
        expect(await changedHarness.undoEntries[0].undo()).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this apply')
        });
        expect(changedHarness.files.get(SCRIPT_PATH)).toBe('model = Box(7, 7, 7)\n');

        const missingHarness = scriptHarness();
        const missingPreview = await previewedScript(missingHarness);
        const missingApplied = await applyScript(missingHarness, missingPreview.proposalId, missingPreview.approvalId);
        const backupPath = (missingApplied.data as { backupPath: string }).backupPath;
        missingHarness.files.delete(backupPath);
        expect(await missingHarness.undoEntries[0].undo()).toMatchObject({
            ok: false,
            message: expect.stringContaining('backup is missing')
        });
        expect(missingHarness.files.get(SCRIPT_PATH)).toBe(SCRIPT_PROPOSED_CONTENT);
        expect((applied.data as { backupPath: string }).backupPath).toContain('/.nuke-ide/ai/backups/cad-scripts/');
    });

    it('parses script preview and apply envelopes strictly', () => {
        expect(readScriptPreviewInput({ baseScriptHash: 'a'.repeat(64), proposedScript: 'model = Box(1, 1, 1)\n' })).toMatchObject({
            ok: true,
            baseScriptHash: 'a'.repeat(64)
        });
        expect(readScriptPreviewInput({ baseScriptHash: 'A'.repeat(64), proposedScript: 'x' })).toMatchObject({
            ok: false,
            message: expect.stringContaining('lowercase SHA-256')
        });
        expect(readScriptPreviewInput({ baseScriptHash: 'a'.repeat(64), proposedScript: 'x', extra: true })).toMatchObject({
            ok: false,
            message: expect.stringContaining("unknown field 'extra'")
        });
        expect(readScriptApplyInput({ proposalId: 'p1', approvalId: 'n1' })).toEqual({
            ok: true,
            proposalId: 'p1',
            approvalId: 'n1'
        });
        expect(readScriptApplyInput({ proposalId: 'p1' })).toMatchObject({
            ok: false,
            message: expect.stringContaining('approvalId is required')
        });
        expect(readScriptApplyInput({ proposalId: 'p1', approvalId: 'n1', approval: 'x' })).toMatchObject({
            ok: false,
            message: expect.stringContaining("unknown field 'approval'")
        });
    });
});
