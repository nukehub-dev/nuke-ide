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

/**
 * Fake-service harness for the CAD authoring capability contract tests.
 *
 * The harness uses the real proposal service and the same document store
 * surface the production capability writes through, so every preview/apply
 * result is produced by the capability's public `invoke` method.
 */

import { vi } from 'vitest';
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
import type { NukeCadDocument, SketchDef } from '../../extensions/nuke-cad/src/common/cad-document';
import type { TopologyRef } from '../../extensions/nuke-cad/src/common/topology-refs';
import type {
    GeometryBuildResult,
    ImportSolidInfo,
    InspectImportSourceRequest,
    InspectImportSourceResult,
    RegionManifestData,
    SandboxedScriptBuildRequest,
    SandboxedScriptBuildResult,
    ScriptSandboxStatus
} from '../../extensions/nuke-cad/src/common/nuke-cad-protocol';
import type {
    CadDocumentStore,
    ImportBodyDraft,
    ImportBodiesRequest
} from '../../extensions/nuke-cad/src/browser/document/cad-document-store';
import type { NukeCadFrontendService } from '../../extensions/nuke-cad/src/browser/nuke-cad-frontend-service';
import type { NukeCadPreferences } from '../../extensions/nuke-cad/src/browser/nuke-cad-preferences';
import type { CadModel, NukeCadStateManager, SolidSummary } from '../../extensions/nuke-cad/src/browser/state/nuke-cad-state-manager';
import type { AssemblyChangeInput } from '../../extensions/nuke-cad/src/common/cad-assembly-edit';
import type { DrawingChangeAction } from '../../extensions/nuke-cad/src/common/cad-drawing-edit';
import type { NukeCadGhostPreviewService } from '../../extensions/nuke-cad/src/browser/preview/nuke-cad-ghost-preview-service';
import type { NukeCadSketchEditService } from '../../extensions/nuke-cad/src/browser/sketch/sketch-edit-service';
import type {
    PreparedSketchEdit,
    SketchEditPrepareResult,
    SketchEditRequest
} from '../../extensions/nuke-cad/src/browser/sketch/sketch-edit-types';
import type { NukeCadScriptAuditService } from '../../extensions/nuke-cad/src/browser/capabilities/script-audit-service';
import { SCRIPT_AUTHORING_PREFERENCE } from '../../extensions/nuke-cad/src/browser/capabilities/nuke-cad-authoring-constants';
import { NukeCadAuthoringCapabilities } from '../../extensions/nuke-cad/src/browser/capabilities/nuke-cad-authoring-capabilities';
import { NukeCadProposalService } from '../../extensions/nuke-cad/src/browser/capabilities/nuke-cad-proposal-service';

export const CAD_WORKSPACE = '/workspace/project';
export const CAD_DOCUMENT_PATH = `${CAD_WORKSPACE}/pincell.nuke-cad`;
export const CAD_CONTEXT: NukeCapabilityContext = { workspaceRoots: [CAD_WORKSPACE], activeCadDocument: CAD_DOCUMENT_PATH };
export const CAD_IMPORT_PATH = `${CAD_WORKSPACE}/gui_pincell.step`;
export const CAD_IMPORT_HASH = 'a'.repeat(64);
export const CAD_IMPORT_SIZE = 4096;

const IMPORT_SOLIDS: readonly ImportSolidInfo[] = [
    { index: 1, name: 'fuel', faceCount: 6, volume: 10, bboxMin: [0, 0, 0], bboxMax: [1, 1, 1], center: [0.5, 0.5, 0.5] },
    { index: 2, name: 'clad', faceCount: 8, volume: 20, bboxMin: [0, 0, 0], bboxMax: [2, 1, 1], center: [1, 0.5, 0.5] },
    { index: 3, name: 'gap', faceCount: 4, volume: 5, bboxMin: [0, 0, 0], bboxMax: [0.5, 0.5, 0.5], center: [0.25, 0.25, 0.25] }
];

const IMPORT_INSPECTION: InspectImportSourceResult = {
    success: true,
    sourceFormat: 'step',
    sourceHash: CAD_IMPORT_HASH,
    sourceSize: CAD_IMPORT_SIZE,
    fileUnit: 'mm',
    effectiveUnit: 'mm',
    unitScaleFactor: 1,
    unitsMessage: 'The source declares millimetres.',
    solidCount: IMPORT_SOLIDS.length,
    solids: IMPORT_SOLIDS,
    warnings: []
};

const MANIFEST: RegionManifestData = {
    version: 1,
    volumes: [{ selector: 'fuel' }, { selector: 'clad' }],
    surfaces: []
};

export const CAD_BUILD_RESULT: GeometryBuildResult = {
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

const PARSED_TESS = {
    version: 1,
    tolerance: 0,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    solids: [],
    faces: [],
    edges: [],
    curves: []
};

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

export const CAD_TOPOLOGY_BUILD_CHANGED_GROUP: GeometryBuildResult = {
    ...TOPOLOGY_BUILD_AFTER,
    regionManifest: {
        version: 1,
        volumes: [{ selector: 'plate', name: 'plate_region_next' }],
        surfaces: []
    }
};

export const CAD_OPENMC_PROJECT_PATH = `${CAD_WORKSPACE}/pincell.nuke-openmc`;
export const CAD_OPENMC_CONTEXT: NukeCapabilityContext = { ...CAD_CONTEXT, activeOpenmcProject: CAD_OPENMC_PROJECT_PATH };
export const CAD_OPENMC_PROJECT_JSON = JSON.stringify({
    version: 1,
    state: {
        settings: {
            dagmcFile: 'pincell.h5m',
            dagmcInfo: { materials: { plate_region: { id: 1 } } }
        },
        materials: []
    }
});

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

export const PATTERN_COUNT_CHANGE = { featureId: 'pattern-1', action: 'patternCount', count: 4 } as const;

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

export const CAD_MOVE_ARM: AssemblyChangeInput = {
    action: 'setPlacement',
    instanceId: 'arm',
    placement: { position: [30, 0, 0], orientation: [0, 0, 0, 1] }
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

export const CAD_DRAWING_ACTIONS: readonly DrawingChangeAction[] = [
    { action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' },
    { action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 0.5, showHidden: true },
    { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-1', visible: false }
];

const SKETCH: SketchDef = {
    id: 'sketch-1',
    name: 'fuel-sketch',
    datumId: 'datum-xy',
    primitives: [],
    constraints: [{ id: 'constraint-1', type: 'radius' }],
    dimensions: [{ id: 'dim-1', constraintId: 'constraint-1', kind: 'radius', targetIds: ['circle-1'], driving: true, value: 0.4 }]
};

export const CAD_SKETCH_REQUEST: readonly SketchEditRequest[] = [{ sketchId: 'sketch-1', dimensionId: 'dim-1', value: 0.44 }];

export const CAD_IMPORT_PREVIEW_INPUT = {
    sourcePath: CAD_IMPORT_PATH,
    strategy: 'perSolid',
    label: 'gui_pincell',
    solidIndexes: [1, 2]
} as const;

export function createFeatureDocument(): NukeCadDocument {
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

export function createTopologyDocument(): NukeCadDocument {
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

export function createAssemblyDocument(): NukeCadDocument {
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

export function createDrawingDocument(): NukeCadDocument {
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

export interface CadContractHarness {
    readonly capabilities: NukeCadAuthoringCapabilities;
    readonly registered: Map<string, NukeCapability>;
    readonly proposals: NukeCadProposalService;
    readonly store: CadDocumentStore;
    readonly stateManager: NukeCadStateManager;
    readonly ghostPreview: { show: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
    readonly commands: string[];
    readonly undoEntries: NukeUndoEntry[];
    readonly edits: { id: string; params: Record<string, unknown> }[][];
    readonly sketchEdits: { sketches: SketchDef[]; parameters: Record<string, number> }[];
    readonly imports: { bodies: readonly ImportBodyDraft[]; bodyIds: string[]; featureIds: string[] }[];
    readonly assemblyChanges: { actions: readonly AssemblyChangeInput[] }[];
    readonly drawingChanges: { actions: readonly DrawingChangeAction[] }[];
    readonly invoke: (id: string, input: unknown, context?: NukeCapabilityContext) => Promise<NukeCapabilityResult>;
}

export interface CadHarnessOptions {
    readonly enabled?: boolean;
    readonly build?: GeometryBuildResult;
    readonly hasModel?: boolean;
    readonly saved?: boolean;
    readonly document?: NukeCadDocument;
    readonly modelResult?: GeometryBuildResult;
    readonly solidSummaries?: readonly SolidSummary[];
    readonly files?: Readonly<Record<string, string>>;
    readonly filesystem?: Readonly<Record<string, Partial<FileStat>>>;
    readonly inspection?: Partial<InspectImportSourceResult>;
    readonly importAddSucceeds?: boolean;
    readonly prepare?: (document: NukeCadDocument, requests: readonly SketchEditRequest[]) => Promise<SketchEditPrepareResult>;
}

export function createCadHarness(overrides: CadHarnessOptions = {}): CadContractHarness {
    let document = overrides.document ?? createFeatureDocument();
    let revision = 3;
    let epoch = 7;
    let drawingVersion = 1;
    const edits: { id: string; params: Record<string, unknown> }[][] = [];
    const sketchEdits: { sketches: SketchDef[]; parameters: Record<string, number> }[] = [];
    const imports: { bodies: readonly ImportBodyDraft[]; bodyIds: string[]; featureIds: string[] }[] = [];
    const assemblyChanges: { actions: readonly AssemblyChangeInput[] }[] = [];
    const drawingChanges: { actions: readonly DrawingChangeAction[] }[] = [];
    const undoEntries: NukeUndoEntry[] = [];
    let assemblyUndoDocument: NukeCadDocument | undefined;
    let drawingUndoDocument: NukeCadDocument | undefined;
    const files = new Map<string, string>();
    for (const [filePath, content] of Object.entries(overrides.files ?? {})) {
        files.set(new URI(filePath).path.toString(), content);
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
    const store = {
        get document(): NukeCadDocument | undefined {
            return document;
        },
        get uri(): string | undefined {
            return overrides.saved === false ? undefined : new URI(CAD_DOCUMENT_PATH).toString();
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
        selectBody: vi.fn(),
        clearSelection: vi.fn()
    } as unknown as CadDocumentStore;

    let stateModel: CadModel | undefined =
        overrides.hasModel === false
            ? undefined
            : ({
                  scriptPath: CAD_DOCUMENT_PATH,
                  result: overrides.modelResult ?? CAD_BUILD_RESULT,
                  manifest: (overrides.modelResult ?? CAD_BUILD_RESULT).regionManifest
              } as CadModel);
    const stateManager = {
        get model(): CadModel | undefined {
            return stateModel;
        },
        get scriptPath(): string | undefined {
            return stateModel?.scriptPath;
        },
        solidSummaries: overrides.solidSummaries ?? [],
        setModel: vi.fn((next: CadModel | undefined) => {
            stateModel = next;
        }),
        setSelection: vi.fn()
    } as unknown as NukeCadStateManager;

    const service = {
        buildDocument: vi.fn(async () => overrides.build ?? CAD_BUILD_RESULT),
        getScriptSandboxStatus: vi.fn(async (): Promise<ScriptSandboxStatus> => ({
            available: false,
            engine: 'bubblewrap',
            reason: 'contract tests'
        })),
        buildSandboxedScript: vi.fn(async (_request: SandboxedScriptBuildRequest): Promise<SandboxedScriptBuildResult> => ({
            success: false,
            error: 'not available in contract tests'
        })),
        cancelJob: vi.fn(async () => true),
        inspectImportSource: vi.fn(async (request: InspectImportSourceRequest): Promise<InspectImportSourceResult> => {
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
                name: filePath.split('/').pop() ?? '',
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
            const content = files.get(source.path.toString());
            if (content === undefined) {
                throw new Error(`File not found: ${source.path.toString()}`);
            }
            files.set(target.path.toString(), content);
            files.delete(source.path.toString());
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
    const fileDialog = { showOpenDialog: vi.fn(async () => new URI(CAD_IMPORT_PATH)) };
    const preferences = {
        get: vi.fn((key: string) => (key === SCRIPT_AUTHORING_PREFERENCE ? false : (overrides.enabled ?? true)))
    };
    const commands: string[] = [];
    const commandService = {
        executeCommand: vi.fn(async (id: string) => {
            commands.push(id);
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
            (async (document_: NukeCadDocument): Promise<SketchEditPrepareResult> => ({
                ok: true,
                result: createPreparedSketchEdit(document_)
            }))
    );
    const sketchEditService = { prepare: sketchPrepare } as unknown as NukeCadSketchEditService;
    const monaco = { getTextDocument: vi.fn(() => undefined) };
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
    (capabilities as unknown as { scriptAudit: NukeCadScriptAuditService }).scriptAudit = {
        record: vi.fn(async () => undefined)
    } as unknown as NukeCadScriptAuditService;
    const registered = new Map<string, NukeCapability>();
    capabilities.registerCapabilities({
        register: (capability: NukeCapability) => registered.set(capability.id, capability)
    } as unknown as NukeCapabilityRegistry);
    return {
        capabilities,
        registered,
        proposals,
        store,
        stateManager,
        ghostPreview,
        commands,
        undoEntries,
        edits,
        sketchEdits,
        imports,
        assemblyChanges,
        drawingChanges,
        invoke: (id, input, context = CAD_CONTEXT) => {
            const capability = registered.get(id);
            if (!capability) {
                throw new Error(`Missing capability ${id}`);
            }
            return capability.invoke(input, context);
        }
    };
}

export function stubCandidateTessellation(harness: CadContractHarness): void {
    vi.spyOn(
        harness.capabilities as unknown as { readCandidateTessellation: () => Promise<typeof TOPOLOGY_PARSED_TESS> },
        'readCandidateTessellation'
    ).mockResolvedValue(TOPOLOGY_PARSED_TESS);
}

export function stubAssemblyTessellation(harness: CadContractHarness): void {
    vi.spyOn(
        harness.capabilities as unknown as { readCandidateTessellation: () => Promise<typeof ASSEMBLY_PARSED_TESS> },
        'readCandidateTessellation'
    ).mockResolvedValue(ASSEMBLY_PARSED_TESS);
}

export function createTopologyHarness(overrides: CadHarnessOptions = {}): CadContractHarness {
    return createCadHarness({
        document: createTopologyDocument(),
        modelResult: TOPOLOGY_BUILD_BEFORE,
        build: TOPOLOGY_BUILD_AFTER,
        solidSummaries: TOPOLOGY_SOLIDS_BEFORE,
        ...overrides
    });
}

export function createAssemblyHarness(overrides: CadHarnessOptions = {}): CadContractHarness {
    return createCadHarness({
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

export function createImportHarness(overrides: CadHarnessOptions = {}): CadContractHarness {
    const { filesystem, ...rest } = overrides;
    return createCadHarness({
        ...rest,
        filesystem: {
            [CAD_IMPORT_PATH]: { isFile: true, size: CAD_IMPORT_SIZE },
            [`${CAD_WORKSPACE}/pincell.parts`]: { isDirectory: true },
            ...filesystem
        }
    });
}

export function createDrawingHarness(overrides: CadHarnessOptions = {}): CadContractHarness {
    return createCadHarness({ document: createDrawingDocument(), ...overrides });
}
