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
 * NukeCAD Authoring Capabilities
 *
 * The narrow AI authoring slice: scalar feature-parameter edits, sketch
 * driving-dimension edits, topology-impacting hole-depth/pattern-count edits,
 * imported STEP/IGES/BREP bodies, assembly-instance placements, and drawing
 * sheet/view/dimension settings on a saved `.nuke-cad` document. Feature,
 * sketch, and topology previews run a real build in a private temporary
 * directory and store a short-lived proposal. Scalar and sketch previews keep
 * the solid count, selector map, and region coverage unchanged; topology
 * previews report the solid and region impact and check saved OpenMC DAGMC
 * references before apply. Import inspection is read-only, previews re-inspect
 * the authorized source and plan bodies without building, and apply commits one
 * `addImportBodies` batch. Drawing summaries are read-only, drawing previews
 * plan settings with no build or ghost, and apply commits one
 * `applyDrawingChanges` batch, refreshes the sheet, and never rebuilds geometry.
 * Every geometry apply writes through the document store, schedules the
 * existing rebuild, and registers a session-scoped undo. The whole authoring
 * surface is default-off behind `nukeCad.aiAuthoringEnabled`; drawing and sketch
 * listing summaries are read-only metadata and stay available.
 *
 * @module nuke-cad/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import * as path from 'path';
import {
    FeatureResult,
    GeometryBuildResult,
    ImportSolidInfo,
    ImportSourceFormat,
    ImportSourceUnit,
    InspectImportSourceRequest,
    InspectImportSourceResult,
    RegionManifestData
} from '../../common/nuke-cad-protocol';
import {
    CAD_FEATURE_EDIT_LIMIT,
    EditableFeatureParam,
    FeatureParamChange,
    prepareFeatureEdit,
    ResolvedFeatureEdit
} from '../../common/cad-feature-edit';
import {
    CAD_TOPOLOGY_EDIT_LIMIT,
    CAD_TOPOLOGY_PATTERN_COUNT_LIMIT,
    FeatureTopologyAction,
    prepareTopologyEdit,
    ResolvedTopologyEdit
} from '../../common/cad-topology-edit';
import { CAD_ASSEMBLY_EDIT_LIMIT, AssemblyChangeInput, AssemblyRemovedRegion, prepareAssemblyEdit } from '../../common/cad-assembly-edit';
import { DRAWING_CHANGE_LIMIT, DrawingChangeAction, prepareDrawingEdit, type PreparedDrawingEdit } from '../../common/cad-drawing-edit';
import { DRAWING_SHEET_DIMENSIONS_MM, formatDrawingScale, isPointOnSheet, type DrawingSheet } from '../../common/cad-drawing';
import { AssemblyBomQuantityRow } from '../../common/assembly-bom';
import { AssemblyInstance, instancePlacementToMatrix, isQuaternion, isVec3, PosQuatPlacement, Vec3 } from '../../common/assembly-document';
import { findOpenmcRegionBlockers, OpenmcRegionBlocker } from '../../common/openmc-region-references';
import { buildTopologyRegions, diffTopology, TopologyBuildSnapshot, TopologyRegionRef } from '../../common/topology-impact';
import {
    FeatureParams,
    NukeCadDocument,
    SketchDef,
    validateNukeCadDocument,
    validateBodyMaterialTag,
    IMPORT_SOURCE_UNITS
} from '../../common/cad-document';
import { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import { NukeCadPreferences } from '../nuke-cad-preferences';
import {
    AssemblySection,
    CadDocumentStore,
    featuresConsumingSketch,
    getAssemblySection,
    ImportBodyDraft
} from '../document/cad-document-store';
import { NukeCadStateManager } from '../state/nuke-cad-state-manager';
import { NukeCadCommands } from '../commands';
import {
    isAssemblyProposal,
    isDrawingProposal,
    isImportProposal,
    isSketchProposal,
    isTopologyProposal,
    NukeCadAssemblyProposal,
    NukeCadAssemblyProposalDetails,
    NukeCadDrawingProposal,
    NukeCadDrawingProposalDetails,
    NukeCadFeatureProposal,
    NukeCadImportProposal,
    NukeCadImportProposalDetails,
    NukeCadProposal,
    NukeCadProposalBuild,
    NukeCadProposalImpact,
    NukeCadProposalService,
    NukeCadSketchProposal,
    NukeCadTopologyProposal
} from './nuke-cad-proposal-service';
import { buildBomRows, instanceSolidIds, solveAssemblyTransforms } from '../widgets/cad-viewport/assembly-view';
import { compareCandidateSolids } from '../preview/ghost-preview-diff';
import { NukeCadGhostPreviewService } from '../preview/nuke-cad-ghost-preview-service';
import { parseTessellationAsync } from '../widgets/cad-viewport/tess-parse-client';
import { AI_AUTHORING_PREFERENCE } from './nuke-cad-authoring-constants';
import { NukeCadSketchEditService, sketchDefinitionsEqual } from '../sketch/sketch-edit-service';
import { CAD_SKETCH_EDIT_LIMIT, PreparedSketchEdit, SketchEditRequest } from '../sketch/sketch-edit-types';
import { readOpenmcRegionReferences } from './openmc-region-reference-reader';
import { inferImportSourceFormat, normalizeImportSourceUnit, planImportBodies } from '../widgets/cad-viewport/import-body';
import { documentRelativeAssemblyPart } from '../widgets/cad-viewport/cad-import-path';
import { validateImportSourcePath, type ValidatedImportSource } from './import-source-policy';

/** Stable capability ids for the feature- and sketch-authoring slice. */
export const PREVIEW_FEATURE_CHANGE_ID = 'nuke.cad.previewFeatureChange';
export const APPLY_FEATURE_CHANGE_ID = 'nuke.cad.applyFeatureChange';
export const LIST_SKETCH_DIMENSIONS_ID = 'nuke.cad.listSketchDimensions';
export const PREVIEW_SKETCH_CHANGE_ID = 'nuke.cad.previewSketchChange';
export const APPLY_SKETCH_CHANGE_ID = 'nuke.cad.applySketchChange';
export const PREVIEW_TOPOLOGY_CHANGE_ID = 'nuke.cad.previewTopologyChange';
export const APPLY_TOPOLOGY_CHANGE_ID = 'nuke.cad.applyTopologyChange';
export const INSPECT_IMPORT_SOURCE_ID = 'nuke.cad.inspectImportSource';
export const PREVIEW_IMPORT_BODIES_ID = 'nuke.cad.previewImportBodies';
export const APPLY_IMPORT_BODIES_ID = 'nuke.cad.applyImportBodies';
export const SUMMARIZE_ASSEMBLY_ID = 'nuke.cad.summarizeAssembly';
export const PREVIEW_ASSEMBLY_CHANGE_ID = 'nuke.cad.previewAssemblyChange';
export const APPLY_ASSEMBLY_CHANGE_ID = 'nuke.cad.applyAssemblyChange';
export const SUMMARIZE_DRAWING_ID = 'nuke.cad.summarizeDrawing';
export const PREVIEW_DRAWING_CHANGE_ID = 'nuke.cad.previewDrawingChange';
export const APPLY_DRAWING_CHANGE_ID = 'nuke.cad.applyDrawingChange';

/** Upper bound the import planner and backend inspection must share. */
const IMPORT_MAX_SOLIDS = 500;

/** Lowercase SHA-256 identity reported by import-source inspection. */
const IMPORT_SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Preview builds must not inherit the backend's one-hour document timeout. */
const PREVIEW_TIMEOUT_SECONDS = 120;

/** The private candidate lives under the workspace and is always deleted. */
const PREVIEW_ROOT = ['.nuke-ide', 'ai', 'cad-previews'] as const;

const CATEGORY = ['CAD', 'Authoring'] as const;

const PREVIEW_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: CAD_FEATURE_EDIT_LIMIT,
            items: {
                type: 'object',
                properties: {
                    featureId: { type: 'string', description: 'Feature id from the active document.' },
                    param: {
                        type: 'string',
                        enum: ['length', 'angle', 'radius', 'thickness', 'distance', 'spacing', 'diameter', 'depth'],
                        description: 'Editable scalar for that feature type.'
                    },
                    value: { type: 'number', description: 'New finite scalar value.' }
                },
                required: ['featureId', 'param', 'value'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

const APPLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewFeatureChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const APPLY_SKETCH_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewSketchChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const PREVIEW_TOPOLOGY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: CAD_TOPOLOGY_EDIT_LIMIT,
            items: {
                type: 'object',
                properties: {
                    featureId: { type: 'string', description: 'Feature id from the active document.' },
                    action: {
                        type: 'string',
                        enum: ['holeDepthMode', 'patternCount'],
                        description: 'Topology-changing action for that feature.'
                    },
                    mode: {
                        type: 'string',
                        enum: ['blind', 'through'],
                        description: 'Hole depth mode; only for holeDepthMode.'
                    },
                    depth: { type: 'number', description: 'Positive blind-hole depth; only for holeDepthMode blind.' },
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: CAD_TOPOLOGY_PATTERN_COUNT_LIMIT,
                        description: 'Pattern instance count; only for patternCount.'
                    }
                },
                required: ['featureId', 'action'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

const APPLY_TOPOLOGY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewTopologyChange.' },
        acknowledgeRegionChanges: {
            type: 'boolean',
            description: 'Must be true to confirm the reported solid and region impact.'
        }
    },
    required: ['proposalId', 'acknowledgeRegionChanges'],
    additionalProperties: false
};

const INSPECT_IMPORT_SOURCE_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        sourcePath: {
            type: 'string',
            description: 'Absolute workspace path to a STEP/IGES/BREP source. Omit to choose the file in a picker.'
        },
        sourceUnit: {
            type: 'string',
            enum: IMPORT_SOURCE_UNITS,
            description: 'Override the unit declared by the source file.'
        }
    },
    additionalProperties: false
};

const INSPECT_IMPORT_SOURCE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Canonical path of the active .nuke-cad document.' },
        documentUnits: { type: 'string', description: 'Length unit of the active document, when defined.' },
        source: {
            type: 'object',
            description: 'Inspected source identity, units, and freshness metadata.'
        },
        solids: {
            type: 'array',
            items: { type: 'object' }
        },
        warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['documentPath', 'source', 'solids', 'warnings']
};

const PREVIEW_IMPORT_BODIES_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        sourcePath: {
            type: 'string',
            description: 'Absolute path of a source already authorized by nuke.cad.inspectImportSource.'
        },
        strategy: {
            type: 'string',
            enum: ['single', 'perSolid'],
            description: 'One body holding every selected solid, or one body per selected solid.'
        },
        label: { type: 'string', description: 'Body label used for naming imported bodies.' },
        solidIndexes: {
            type: 'array',
            minItems: 1,
            maxItems: IMPORT_MAX_SOLIDS,
            items: { type: 'integer', minimum: 1 },
            description: '1-based source-solid indexes to import.'
        },
        sourceUnit: {
            type: 'string',
            enum: IMPORT_SOURCE_UNITS,
            description: 'Override the unit declared by the source file.'
        },
        material: {
            type: 'string',
            description: 'Optional in-CAD material tag applied to every imported body.'
        }
    },
    required: ['sourcePath', 'strategy', 'label', 'solidIndexes'],
    additionalProperties: false
};

const PREVIEW_IMPORT_BODIES_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: { type: 'array' },
        import: { type: 'object' },
        warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['proposalId', 'summary', 'changes', 'import', 'warnings']
};

const APPLY_IMPORT_BODIES_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewImportBodies.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const ASSEMBLY_PLACEMENT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        position: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: { type: 'number' },
            description: 'Translation in assembly units.'
        },
        orientation: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'number' },
            description: 'Unit quaternion in [x, y, z, w] order.'
        }
    },
    required: ['position', 'orientation'],
    additionalProperties: false
};

const PREVIEW_ASSEMBLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: CAD_ASSEMBLY_EDIT_LIMIT,
            items: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['addInstance', 'removeInstance', 'setPlacement'],
                        description: 'Assembly instance action.'
                    },
                    id: { type: 'string', description: 'New instance id; generated when omitted.' },
                    part: { type: 'string', description: 'Existing body:<id> source or an existing instance part string.' },
                    instanceId: { type: 'string', description: 'Target instance for removeInstance/setPlacement.' },
                    placement: ASSEMBLY_PLACEMENT_SCHEMA,
                    scale: {
                        description: 'Positive uniform scale or [sx, sy, sz] per-axis scale.',
                        oneOf: [
                            { type: 'number', exclusiveMinimum: 0 },
                            {
                                type: 'array',
                                minItems: 3,
                                maxItems: 3,
                                items: { type: 'number', exclusiveMinimum: 0 }
                            }
                        ]
                    }
                },
                required: ['action'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

const APPLY_ASSEMBLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewAssemblyChange.' },
        acknowledgeRegionChanges: {
            type: 'boolean',
            description: 'Must be true when the preview removed the last instance of a labelled body.'
        }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const SUMMARIZE_ASSEMBLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const SUMMARIZE_ASSEMBLY_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Canonical path of the active .nuke-cad document.' },
        hasAssembly: { type: 'boolean' },
        groundedInstanceId: { type: 'string' },
        overlapCheck: { type: 'boolean' },
        instances: { type: 'array', items: { type: 'object' } },
        bom: { type: 'array', items: { type: 'object' } },
        connectors: { type: 'array', items: { type: 'object' } },
        mates: { type: 'array', items: { type: 'object' } },
        warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['documentPath', 'hasAssembly', 'groundedInstanceId', 'overlapCheck', 'instances', 'bom', 'connectors', 'mates', 'warnings']
};

const SUMMARIZE_DRAWING_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const SUMMARIZE_DRAWING_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Canonical path of the active .nuke-cad document.' },
        hasDrawings: { type: 'boolean' },
        drawingVersion: { type: 'integer' },
        sheets: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    size: { type: 'string', enum: ['A4', 'A3'] },
                    orientation: { type: 'string', enum: ['landscape'] },
                    sheetSizeMm: {
                        type: 'object',
                        properties: { width: { type: 'number' }, height: { type: 'number' } },
                        required: ['width', 'height'],
                        additionalProperties: false
                    },
                    scaleLabel: { type: 'string' }
                },
                required: ['id', 'name', 'size', 'orientation', 'sheetSizeMm', 'scaleLabel'],
                additionalProperties: false
            }
        },
        views: { type: 'array', items: { type: 'object' } },
        dimensions: { type: 'array', items: { type: 'object' } },
        titleBlock: { type: 'object' },
        warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['documentPath', 'hasDrawings', 'drawingVersion', 'sheets', 'views', 'dimensions', 'titleBlock', 'warnings']
};

const PREVIEW_DRAWING_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: DRAWING_CHANGE_LIMIT,
            items: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['setSheetSize', 'setViewDisplay', 'setDimensionVisibility'],
                        description: 'Drawing setting to change.'
                    },
                    sheetId: { type: 'string', description: 'Existing drawing sheet id; every action targets the same sheet.' },
                    size: { type: 'string', enum: ['A4', 'A3'], description: 'New landscape sheet size; only for setSheetSize.' },
                    viewId: { type: 'string', description: 'Existing view id; only for setViewDisplay.' },
                    scale: { type: 'number', description: 'View multiplier in [0.001, 1000]; only for setViewDisplay.' },
                    showHidden: { type: 'boolean', description: 'Draw hidden lines; only for setViewDisplay.' },
                    dimensionId: { type: 'string', description: 'Existing dimension id; only for setDimensionVisibility.' },
                    visible: { type: 'boolean', description: 'Show the dimension; only for setDimensionVisibility.' }
                },
                required: ['action', 'sheetId'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

const PREVIEW_DRAWING_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: { type: 'array' },
        drawing: { type: 'object' },
        warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['proposalId', 'summary', 'changes', 'drawing', 'warnings']
};

const APPLY_DRAWING_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewDrawingChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const PREVIEW_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: { type: 'array' },
        impact: { type: 'object' },
        build: { type: 'object' }
    },
    required: ['proposalId', 'summary', 'changes', 'impact']
};

const LIST_SKETCH_DIMENSIONS_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const LIST_SKETCH_DIMENSIONS_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Canonical path of the active .nuke-cad document.' },
        parameters: {
            type: 'object',
            description: 'Document parameter name to current value.',
            additionalProperties: { type: 'number' }
        },
        sketches: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    datumId: { type: 'string' },
                    consumedByFeatureIds: { type: 'array', items: { type: 'string' } },
                    dimensions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                kind: {
                                    type: 'string',
                                    enum: ['distance', 'distanceH', 'distanceV', 'angle', 'radius', 'diameter']
                                },
                                driving: { type: 'boolean' },
                                parameter: { type: 'string', description: 'Document parameter driving the dimension, when bound.' },
                                value: { type: 'number' }
                            },
                            required: ['id', 'kind', 'driving', 'value'],
                            additionalProperties: false
                        }
                    }
                },
                required: ['id', 'name', 'datumId', 'consumedByFeatureIds', 'dimensions'],
                additionalProperties: false
            }
        }
    },
    required: ['documentPath', 'parameters', 'sketches']
};

const PREVIEW_SKETCH_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: CAD_SKETCH_EDIT_LIMIT,
            items: {
                type: 'object',
                properties: {
                    sketchId: { type: 'string', description: 'Sketch id from nuke.cad.listSketchDimensions.' },
                    dimensionId: { type: 'string', description: 'Driving dimension id on that sketch.' },
                    parameterName: { type: 'string', description: 'Document parameter referenced by that sketch.' },
                    value: { type: 'number', description: 'New finite scalar value.' }
                },
                required: ['sketchId', 'value'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

/** Session-scoped authorization and metadata for one inspected import source. */
interface ImportGrant {
    readonly path: string;
    readonly sourceHash: string;
    readonly sourceSize?: number;
    readonly sourceFormat?: ImportSourceFormat;
    readonly fileUnit?: string;
    readonly effectiveUnit?: string;
    readonly unitScaleFactor?: number;
    readonly unitsMessage?: string;
    readonly solids: readonly ImportSolidInfo[];
    readonly sourceUnit?: ImportSourceUnit;
}

/** Preview/apply capabilities for scalar feature and sketch-dimension `.nuke-cad` edits. */
@injectable()
export class NukeCadAuthoringCapabilities implements NukeCapabilityContribution {
    /** Import sources the user authorized during this session, keyed by canonical path. */
    private readonly importGrants = new Map<string, ImportGrant>();

    constructor(
        @inject(NukeCadStateManager) protected readonly stateManager: NukeCadStateManager,
        @inject(NukeCadFrontendService) protected readonly service: NukeCadFrontendService,
        @inject(CadDocumentStore) protected readonly store: CadDocumentStore,
        @inject(NukeCadProposalService) protected readonly proposals: NukeCadProposalService,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(FileDialogService) protected readonly fileDialogService: FileDialogService,
        @inject(NukeCadPreferences) protected readonly preferences: NukeCadPreferences,
        @inject(CommandService) protected readonly commands: CommandService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService,
        @inject(NukeCadGhostPreviewService) protected readonly ghostPreview: NukeCadGhostPreviewService,
        @inject(NukeCadSketchEditService) protected readonly sketchEditService: NukeCadSketchEditService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register(this.listSketchDimensionsCapability());
        registry.register(this.previewCapability());
        registry.register(this.applyCapability());
        registry.register(this.previewSketchCapability());
        registry.register(this.applySketchCapability());
        registry.register(this.previewTopologyCapability());
        registry.register(this.applyTopologyCapability());
        registry.register(this.inspectImportSourceCapability());
        registry.register(this.previewImportBodiesCapability());
        registry.register(this.applyImportBodiesCapability());
        registry.register(this.summarizeAssemblyCapability());
        registry.register(this.previewAssemblyCapability());
        registry.register(this.applyAssemblyCapability());
        registry.register(this.summarizeDrawingCapability());
        registry.register(this.previewDrawingCapability());
        registry.register(this.applyDrawingCapability());
    }

    protected previewCapability(): NukeCapability {
        return {
            id: PREVIEW_FEATURE_CHANGE_ID,
            title: 'Preview CAD feature change',
            description:
                'Propose scalar feature-parameter edits (length, angle, radius, thickness) for the active saved .nuke-cad ' +
                'document and validate them with a real build before anything is written. The preview is read-only.',
            category: CATEGORY,
            inputSchema: PREVIEW_INPUT_SCHEMA,
            outputSchema: PREVIEW_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'preview'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewFeatureChange(input, context)
        };
    }

    protected listSketchDimensionsCapability(): NukeCapability {
        return {
            id: LIST_SKETCH_DIMENSIONS_ID,
            title: 'List CAD sketch dimensions',
            description:
                'Read the active .nuke-cad document parameters, sketches, and driving/reference dimensions. This is read-only ' +
                'metadata to call before previewing a sketch change; it works even when AI authoring is off.',
            category: CATEGORY,
            inputSchema: LIST_SKETCH_DIMENSIONS_INPUT_SCHEMA,
            outputSchema: LIST_SKETCH_DIMENSIONS_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'sketch', 'read'],
            when: () => this.store.document !== undefined,
            invoke: () => this.listSketchDimensions()
        };
    }

    protected previewSketchCapability(): NukeCapability {
        return {
            id: PREVIEW_SKETCH_CHANGE_ID,
            title: 'Preview CAD sketch change',
            description:
                'Propose driving-dimension or referenced-parameter edits for one sketch in the active saved .nuke-cad ' +
                'document, re-solve the affected sketches, and validate the result with a real build before anything is written. ' +
                'The preview is read-only.',
            category: CATEGORY,
            inputSchema: PREVIEW_SKETCH_INPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'preview', 'sketch'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewSketchChange(input, context)
        };
    }

    protected applySketchCapability(): NukeCapability {
        return {
            id: APPLY_SKETCH_CHANGE_ID,
            title: 'Apply CAD sketch change',
            description:
                'Apply a previewed sketch-dimension change to the active .nuke-cad document, schedule the rebuild, and ' +
                'return an undo token. Accepts only a proposal id.',
            category: CATEGORY,
            inputSchema: APPLY_SKETCH_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply', 'sketch'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input) => this.applySketchChange(input)
        };
    }

    protected applyCapability(): NukeCapability {
        return {
            id: APPLY_FEATURE_CHANGE_ID,
            title: 'Apply CAD feature change',
            description:
                'Apply a previewed scalar feature-parameter change to the active .nuke-cad document, schedule the rebuild, ' +
                'and return an undo token. Accepts only a proposal id.',
            category: CATEGORY,
            inputSchema: APPLY_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.applyFeatureChange(input, context)
        };
    }

    protected previewTopologyCapability(): NukeCapability {
        return {
            id: PREVIEW_TOPOLOGY_CHANGE_ID,
            title: 'Preview CAD topology change',
            description:
                'Propose hole blind/through or pattern-count edits for the active saved .nuke-cad document, validate the ' +
                'candidate with a real build, and report the solid and region impact plus any saved OpenMC references ' +
                'the change would break. The preview is read-only.',
            category: CATEGORY,
            inputSchema: PREVIEW_TOPOLOGY_INPUT_SCHEMA,
            outputSchema: PREVIEW_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'preview', 'topology'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewTopologyChange(input, context)
        };
    }

    protected applyTopologyCapability(): NukeCapability {
        return {
            id: APPLY_TOPOLOGY_CHANGE_ID,
            title: 'Apply CAD topology change',
            description:
                'Apply a previewed topology change after the region impact is acknowledged, schedule the rebuild, and ' +
                'return an undo token. Rejects proposals that would break saved OpenMC DAGMC references.',
            category: CATEGORY,
            inputSchema: APPLY_TOPOLOGY_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply', 'topology'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.applyTopologyChange(input, context)
        };
    }

    protected inspectImportSourceCapability(): NukeCapability {
        return {
            id: INSPECT_IMPORT_SOURCE_ID,
            title: 'Inspect CAD import source',
            description:
                'Authorize and inspect a workspace STEP/IGES/BREP source for import into the active saved .nuke-cad ' +
                'document. A direct path is used only when it is inside the document-owned .parts folder or was already ' +
                'authorized in this session; otherwise the user chooses the file. Read-only: returns the source hash, ' +
                'size, units, and solids without writing geometry.',
            category: CATEGORY,
            inputSchema: INSPECT_IMPORT_SOURCE_INPUT_SCHEMA,
            outputSchema: INSPECT_IMPORT_SOURCE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'import', 'read'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.inspectImportSource(input, context)
        };
    }

    protected previewImportBodiesCapability(): NukeCapability {
        return {
            id: PREVIEW_IMPORT_BODIES_ID,
            title: 'Preview CAD body import',
            description:
                'Plan imported body features from an authorized STEP/IGES/BREP source and open the CAD Edit Review ' +
                'panel. Re-inspects the source so the proposal carries current solid fingerprints; the preview never ' +
                'mutates the document, builds geometry, or publishes a ghost.',
            category: CATEGORY,
            inputSchema: PREVIEW_IMPORT_BODIES_INPUT_SCHEMA,
            outputSchema: PREVIEW_IMPORT_BODIES_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'import', 'preview'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewImportBodies(input, context)
        };
    }

    protected applyImportBodiesCapability(): NukeCapability {
        return {
            id: APPLY_IMPORT_BODIES_ID,
            title: 'Apply CAD body import',
            description:
                'Apply a previewed body import to the active .nuke-cad document in one atomic batch, back up the ' +
                'document, schedule the rebuild, and return an undo token. Rejects a changed source or stale plan.',
            category: CATEGORY,
            inputSchema: APPLY_IMPORT_BODIES_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply', 'import'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.applyImportBodies(input, context)
        };
    }

    protected summarizeAssemblyCapability(): NukeCapability {
        return {
            id: SUMMARIZE_ASSEMBLY_ID,
            title: 'Summarize CAD assembly',
            description:
                'Read the active .nuke-cad assembly: instances, part sources, placements and solved matrices, selector solid ' +
                'ids, BOM quantities, connectors, mates, grounding, and the instance-overlap policy. Read-only metadata for ' +
                'planning an assembly placement change; it works even when AI authoring is off.',
            category: CATEGORY,
            inputSchema: SUMMARIZE_ASSEMBLY_INPUT_SCHEMA,
            outputSchema: SUMMARIZE_ASSEMBLY_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'assembly', 'read'],
            when: () => this.store.document !== undefined,
            invoke: () => this.summarizeAssembly()
        };
    }

    protected previewAssemblyCapability(): NukeCapability {
        return {
            id: PREVIEW_ASSEMBLY_CHANGE_ID,
            title: 'Preview CAD assembly change',
            description:
                'Propose assembly instance add/remove/placement actions for the active saved .nuke-cad document, validate ' +
                'the candidate with a real build, and report planned transforms, BOM delta, overlap warnings, and any ' +
                'labelled region or saved OpenMC reference the change would break. The preview is read-only.',
            category: CATEGORY,
            inputSchema: PREVIEW_ASSEMBLY_INPUT_SCHEMA,
            outputSchema: PREVIEW_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'preview', 'assembly'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewAssemblyChange(input, context)
        };
    }

    protected applyAssemblyCapability(): NukeCapability {
        return {
            id: APPLY_ASSEMBLY_CHANGE_ID,
            title: 'Apply CAD assembly change',
            description:
                'Apply a previewed assembly instance change after any removed-region impact is acknowledged, schedule the ' +
                'rebuild, and return an undo token. Rejects proposals that would break saved OpenMC DAGMC references.',
            category: CATEGORY,
            inputSchema: APPLY_ASSEMBLY_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply', 'assembly'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.applyAssemblyChange(input, context)
        };
    }

    protected summarizeDrawingCapability(): NukeCapability {
        return {
            id: SUMMARIZE_DRAWING_ID,
            title: 'Summarize CAD drawing',
            description:
                'Read the active .nuke-cad drawing sheets: sheet size and millimetre bounds, views with scale and hidden-line ' +
                'display, dimensions with visibility/value/staleness and target feature ids, and the read-only title-block ' +
                'fields. Read-only metadata for planning drawing settings; it works even when AI authoring is off.',
            category: CATEGORY,
            inputSchema: SUMMARIZE_DRAWING_INPUT_SCHEMA,
            outputSchema: SUMMARIZE_DRAWING_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'drawing', 'read'],
            when: () => this.store.document !== undefined,
            invoke: () => this.summarizeDrawing()
        };
    }

    protected previewDrawingCapability(): NukeCapability {
        return {
            id: PREVIEW_DRAWING_CHANGE_ID,
            title: 'Preview CAD drawing change',
            description:
                'Propose sheet-size, view scale/hidden-line, and dimension-visibility changes for one sheet of the active ' +
                'saved .nuke-cad document and open the CAD Edit Review panel. The preview never builds geometry, writes files, ' +
                'or publishes a ghost; applying it only refreshes the drawing sheet.',
            category: CATEGORY,
            inputSchema: PREVIEW_DRAWING_INPUT_SCHEMA,
            outputSchema: PREVIEW_DRAWING_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'drawing', 'preview'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewDrawingChange(input, context)
        };
    }

    protected applyDrawingCapability(): NukeCapability {
        return {
            id: APPLY_DRAWING_CHANGE_ID,
            title: 'Apply CAD drawing change',
            description:
                'Apply a previewed drawing-sheet settings change to the active .nuke-cad document in one drawing commit, back ' +
                'up the document, open and refresh the Drawing Sheet, and return an undo token. Never rebuilds geometry.',
            category: CATEGORY,
            inputSchema: APPLY_DRAWING_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply', 'drawing'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input) => this.applyDrawingChange(input)
        };
    }

    protected enabled(): boolean {
        return this.preferences.get(AI_AUTHORING_PREFERENCE) === true;
    }

    protected hasActiveDocument(): boolean {
        return this.stateManager.model !== undefined && this.store.document !== undefined && this.activeDocumentPath() !== undefined;
    }

    /** Canonical file path of the open document, independent of the URI encoding. */
    protected activeDocumentPath(): string | undefined {
        const uri = this.store.uri;
        return uri ? new URI(uri).path.toString() : undefined;
    }

    protected disabledResult(): NukeCapabilityResult {
        return {
            ok: false,
            message: 'CAD AI authoring is disabled. Enable "Nuke CAD: AI Authoring" in Settings → Nuke CAD first.'
        };
    }

    protected inactiveResult(): NukeCapabilityResult {
        return { ok: false, message: 'Open a saved .nuke-cad document before previewing a feature change.' };
    }

    /**
     * Authorize and inspect a STEP/IGES/BREP source without writing anything.
     *
     * A caller-supplied path is a hint only: the session grant or the
     * document-owned `.parts` folder skips the picker; every other path opens
     * the native file dialog. Unsafe supplied paths fail before the picker.
     */
    protected async inspectImportSource(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const document = this.store.document;
        const documentPath = this.activeDocumentPath();
        if (!document || !documentPath || this.stateManager.model === undefined) {
            return this.inactiveResult();
        }
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const parsed = readInspectImportSourceInput(input);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }

        let source: ValidatedImportSource;
        if (parsed.sourcePath !== undefined) {
            const validation = await validateImportSourcePath(this.fileService, parsed.sourcePath, context.workspaceRoots, documentPath);
            if (!validation.ok) {
                return { ok: false, message: validation.message };
            }
            if (this.importGrants.has(validation.value.path) || validation.value.implicitPartsSource) {
                source = validation.value;
            } else {
                const chosen = await this.chooseImportSource(context.workspaceRoots, documentPath);
                if (!chosen.ok) {
                    return { ok: false, message: chosen.message };
                }
                source = chosen.value;
            }
        } else {
            const chosen = await this.chooseImportSource(context.workspaceRoots, documentPath);
            if (!chosen.ok) {
                return { ok: false, message: chosen.message };
            }
            source = chosen.value;
        }

        const inspected = await this.inspectAuthorizedImportSource(source.path, parsed.sourceUnit, document);
        if (!inspected.ok) {
            return { ok: false, message: inspected.message };
        }
        this.rememberImportGrant(source.path, inspected.inspection, parsed.sourceUnit);
        const warnings = this.importSourceWarnings(documentPath, source.path, inspected.inspection, {
            sourceUnit: parsed.sourceUnit
        });
        return {
            ok: true,
            data: {
                documentPath,
                ...(document.units !== undefined ? { documentUnits: document.units } : {}),
                source: this.importSourceMetadata(source.path, inspected.inspection, parsed.sourceUnit),
                solids: inspected.inspection.solids,
                warnings
            },
            warnings
        };
    }

    /**
     * Plan an imported-body preview from an authorized source.
     *
     * The source is inspected again for current solid fingerprints, then the
     * pure planner builds exact drafts. Nothing is committed and no build or
     * ghost preview runs; the review panel applies the same capability.
     */
    protected async previewImportBodies(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const document = this.store.document;
        const documentPath = this.activeDocumentPath();
        if (!document || !documentPath || this.stateManager.model === undefined) {
            return this.inactiveResult();
        }
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const parsed = readImportPreviewInput(input);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }
        const material = parsed.material?.trim();
        if (material !== undefined && material.length > 0) {
            const materialError = validateBodyMaterialTag(material);
            if (materialError !== undefined) {
                return { ok: false, message: materialError };
            }
        }
        const validation = await validateImportSourcePath(this.fileService, parsed.sourcePath, context.workspaceRoots, documentPath);
        if (!validation.ok) {
            return { ok: false, message: validation.message };
        }
        const source = validation.value;
        if (!this.importGrants.has(source.path)) {
            return {
                ok: false,
                message: 'Inspect and authorize this CAD import source with nuke.cad.inspectImportSource before previewing bodies.'
            };
        }
        const epoch = this.store.documentEpoch;
        const revision = this.store.revision;
        const inspected = await this.inspectAuthorizedImportSource(source.path, parsed.sourceUnit, document);
        if (!inspected.ok) {
            return { ok: false, message: inspected.message };
        }
        if (this.store.documentEpoch !== epoch || this.store.revision !== revision) {
            return { ok: false, message: 'The document changed while the import source was inspected. Preview the import again.' };
        }
        const inspection = inspected.inspection;
        this.rememberImportGrant(source.path, inspection, parsed.sourceUnit);

        const sourceFormat = inspection.sourceFormat ?? inferImportSourceFormat(source.path);
        const plan = planImportBodies(
            {
                sourcePath: documentRelativeAssemblyPart(documentPath, source.path),
                sourceHash: inspection.sourceHash!,
                ...(inspection.sourceSize !== undefined ? { sourceSize: inspection.sourceSize } : {}),
                ...(sourceFormat !== undefined ? { sourceFormat } : {}),
                maxSolids: IMPORT_MAX_SOLIDS
            },
            {
                strategy: parsed.strategy,
                label: parsed.label,
                solidIndexes: parsed.solidIndexes,
                ...(parsed.sourceUnit !== undefined ? { sourceUnit: parsed.sourceUnit } : {})
            },
            inspection.solids!,
            document.bodies.map((body) => body.name)
        );
        if (!plan.ok) {
            return { ok: false, message: plan.error };
        }
        const drafts: ImportBodyDraft[] =
            material !== undefined && material.length > 0
                ? plan.drafts.map((draft) => ({ ...draft, material }))
                : plan.drafts.map((draft) => ({ ...draft }));
        const indexes = [...new Set(parsed.solidIndexes)].sort((left, right) => left - right);
        const byIndex = new Map(inspection.solids!.map((solid) => [solid.index, solid] as const));
        const selectedSolids = indexes.map((index) => byIndex.get(index)).filter((solid): solid is ImportSolidInfo => solid !== undefined);
        const bodies = drafts.map((draft) => ({
            name: draft.name,
            ...(draft.label !== undefined ? { label: draft.label } : {}),
            ...(draft.material !== undefined ? { material: draft.material } : {}),
            featureName: draft.name
        }));
        const warnings = this.importSourceWarnings(documentPath, source.path, inspection, {
            sourceUnit: parsed.sourceUnit,
            material: material !== undefined && material.length > 0 ? material : undefined,
            selectedCount: indexes.length
        });
        const sourceMetadata = this.importSourceMetadata(source.path, inspection, parsed.sourceUnit);
        const details: NukeCadImportProposalDetails = {
            source: sourceMetadata,
            ...(document.units !== undefined ? { documentUnits: document.units } : {}),
            strategy: parsed.strategy,
            label: parsed.label.trim(),
            solidCount: inspection.solidCount ?? inspection.solids!.length,
            solidIndexes: indexes,
            selectedSolids,
            drafts,
            bodies,
            warnings
        };
        const summary = importSummary(drafts.length, selectedSolids.length, path.basename(source.path));
        const changes = drafts.map((draft) => ({
            path: `bodies.${draft.name}`,
            label: `Body ${draft.name}`,
            kind: 'add' as const,
            after: draft.name
        }));
        const proposal = this.proposals.create({
            scope: 'import',
            applyCapability: APPLY_IMPORT_BODIES_ID,
            summary,
            documentPath,
            documentEpoch: epoch,
            baseRevision: revision,
            changes,
            import: details
        });
        void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
        return {
            ok: true,
            data: {
                proposalId: proposal.id,
                summary,
                changes,
                import: details,
                warnings
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD import bodies',
                summary,
                changes,
                applyCapability: APPLY_IMPORT_BODIES_ID
            },
            warnings
        };
    }

    /**
     * Commit a previewed import as one `addImportBodies` batch.
     *
     * The source path is re-validated against the current workspace and
     * filesystem, then its hash/size/format and the exact re-planned drafts
     * must still match the preview; a backup is written before the single
     * commit, the rebuild is scheduled, and a session undo token is registered.
     */
    protected async applyImportBodies(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const proposalId = readProposalId(input);
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        if (!isImportProposal(proposal)) {
            return { ok: false, message: this.wrongScopeApplyMessage(proposal) };
        }
        const stale = this.importStaleReason(proposal);
        if (stale) {
            return { ok: false, message: stale };
        }
        const validation = await validateImportSourcePath(
            this.fileService,
            proposal.import.source.path,
            context.workspaceRoots,
            proposal.documentPath
        );
        if (!validation.ok) {
            return { ok: false, message: validation.message };
        }
        const document = this.store.document;
        if (!document) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        const sourcePath = validation.value.path;
        const checkedEpoch = this.store.documentEpoch;
        const checkedRevision = this.store.revision;
        const inspected = await this.inspectAuthorizedImportSource(sourcePath, proposal.import.source.sourceUnit, document);
        if (!inspected.ok) {
            return { ok: false, message: inspected.message };
        }
        if (this.store.documentEpoch !== checkedEpoch || this.store.revision !== checkedRevision) {
            return { ok: false, message: 'The document changed while the import source was inspected. Preview the import again.' };
        }
        const inspection = inspected.inspection;
        const currentFormat = inspection.sourceFormat ?? inferImportSourceFormat(sourcePath);
        if (inspection.sourceHash !== proposal.import.source.sourceHash) {
            return { ok: false, message: 'The CAD import source changed after this preview. Preview the import again.' };
        }
        if (proposal.import.source.sourceSize !== undefined && inspection.sourceSize !== proposal.import.source.sourceSize) {
            return { ok: false, message: 'The CAD import source changed after this preview. Preview the import again.' };
        }
        if (proposal.import.source.sourceFormat !== undefined && currentFormat !== proposal.import.source.sourceFormat) {
            return { ok: false, message: 'The CAD import source format changed after this preview. Preview the import again.' };
        }
        this.rememberImportGrant(sourcePath, inspection, proposal.import.source.sourceUnit);
        const plan = planImportBodies(
            {
                sourcePath: documentRelativeAssemblyPart(proposal.documentPath, sourcePath),
                sourceHash: inspection.sourceHash!,
                ...(inspection.sourceSize !== undefined ? { sourceSize: inspection.sourceSize } : {}),
                ...(currentFormat !== undefined ? { sourceFormat: currentFormat } : {}),
                maxSolids: IMPORT_MAX_SOLIDS
            },
            {
                strategy: proposal.import.strategy,
                label: proposal.import.label,
                solidIndexes: proposal.import.solidIndexes,
                ...(proposal.import.source.sourceUnit !== undefined ? { sourceUnit: proposal.import.source.sourceUnit } : {})
            },
            inspection.solids!,
            document.bodies.map((body) => body.name)
        );
        if (!plan.ok) {
            return { ok: false, message: plan.error };
        }
        const replannedDrafts = withProposalMaterials(plan.drafts, proposal.import.drafts);
        if (stableStringify(replannedDrafts) !== stableStringify(proposal.import.drafts)) {
            return { ok: false, message: 'The CAD import plan changed after this preview. Preview the import again.' };
        }
        const backupPath = path.join(path.dirname(proposal.documentPath), `.nuke-ai-backup-${path.basename(proposal.documentPath)}`);
        try {
            const snapshot = this.store.toJson();
            if (!snapshot) {
                return { ok: false, message: 'The active CAD document could not be read for a backup.' };
            }
            await this.fileService.create(new URI(backupPath), snapshot, { overwrite: true });
        } catch (error) {
            return { ok: false, message: `Could not write the pre-apply CAD backup: ${errorMessage(error)}` };
        }
        const added = this.store.addImportBodies({ bodies: proposal.import.drafts });
        if (!added.success) {
            return { ok: false, message: added.error || 'The CAD document rejected the import.', warnings: formatIssues(added.issues) };
        }
        const bodyIds = added.value?.bodyIds ?? [];
        const featureIds = added.value?.featureIds ?? [];
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD import bodies',
            undo: () => this.undoImportBodies(proposal, appliedRevision)
        });
        return {
            ok: true,
            message: 'CAD import applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                bodyIds,
                featureIds,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                rebuildScheduled: true
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD import bodies',
                summary: proposal.summary,
                changes: proposal.changes
            },
            undoToken
        };
    }

    protected async undoImportBodies(proposal: NukeCadImportProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
        if (!this.hasActiveDocument()) {
            return { ok: false, message: 'Open the document again before undoing this change.' };
        }
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return { ok: false, message: 'This change belongs to a different document and can no longer be undone.' };
        }
        if (this.store.revision !== appliedRevision) {
            return { ok: false, message: 'The document changed after this edit. Preview the change again.' };
        }
        const result = this.store.undo();
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        this.store.selectBody(undefined);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD import undone.' };
    }

    protected importStaleReason(proposal: NukeCadImportProposal): string | undefined {
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return 'The active document changed after this preview. Preview the change again.';
        }
        if (this.store.revision !== proposal.baseRevision) {
            return 'The document changed after this preview. Preview the change again.';
        }
        return undefined;
    }

    /** Open the picker and validate the chosen source before any inspection. */
    protected async chooseImportSource(
        workspaceRoots: readonly string[],
        documentPath: string
    ): Promise<{ ok: true; value: ValidatedImportSource } | { ok: false; message: string }> {
        let chosen: URI | undefined;
        try {
            chosen = await this.fileDialogService.showOpenDialog({
                title: 'Authorize CAD import source',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'CAD Exchange Files': ['step', 'stp', 'iges', 'igs', 'brep']
                }
            });
        } catch (error) {
            return { ok: false, message: `Could not open the CAD import source picker: ${errorMessage(error)}` };
        }
        if (chosen === undefined) {
            return { ok: false, message: 'No CAD import source was selected.' };
        }
        return validateImportSourcePath(this.fileService, chosen.path.toString(), workspaceRoots, documentPath);
    }

    /** Inspect an already-authorized source and reject incomplete metadata. */
    protected async inspectAuthorizedImportSource(
        sourcePath: string,
        sourceUnit: ImportSourceUnit | undefined,
        document: NukeCadDocument
    ): Promise<{ ok: true; inspection: InspectImportSourceResult } | { ok: false; message: string }> {
        const request: InspectImportSourceRequest = {
            sourcePath,
            maxSolids: IMPORT_MAX_SOLIDS,
            ...(sourceUnit !== undefined ? { sourceUnit } : {}),
            ...(document.units !== undefined ? { targetUnits: document.units } : {})
        };
        let inspection: InspectImportSourceResult;
        try {
            inspection = await this.service.inspectImportSource(request);
        } catch (error) {
            return { ok: false, message: `The CAD import source could not be inspected: ${errorMessage(error)}` };
        }
        if (inspection.sourcePath !== undefined && path.resolve(inspection.sourcePath) !== sourcePath) {
            return { ok: false, message: 'The CAD import inspection returned a different source path.' };
        }
        if (!inspection.success) {
            return { ok: false, message: inspection.error || `Failed to inspect '${path.basename(sourcePath)}'.` };
        }
        if (inspection.sourceHash === undefined || !IMPORT_SOURCE_HASH_PATTERN.test(inspection.sourceHash)) {
            return { ok: false, message: 'The CAD import inspection did not return a valid SHA-256 source hash.' };
        }
        if (inspection.solids === undefined || inspection.solids.length === 0) {
            return { ok: false, message: `'${path.basename(sourcePath)}' contains no solids to import.` };
        }
        return { ok: true, inspection };
    }

    /** Cache the session grant so later previews skip the picker. */
    protected rememberImportGrant(
        sourcePath: string,
        inspection: InspectImportSourceResult,
        sourceUnit: ImportSourceUnit | undefined
    ): void {
        const sourceFormat = inspection.sourceFormat ?? inferImportSourceFormat(sourcePath);
        this.importGrants.set(sourcePath, {
            path: sourcePath,
            sourceHash: inspection.sourceHash!,
            ...(inspection.sourceSize !== undefined ? { sourceSize: inspection.sourceSize } : {}),
            ...(sourceFormat !== undefined ? { sourceFormat } : {}),
            ...(inspection.fileUnit !== undefined ? { fileUnit: inspection.fileUnit } : {}),
            ...(inspection.effectiveUnit !== undefined ? { effectiveUnit: inspection.effectiveUnit } : {}),
            ...(inspection.unitScaleFactor !== undefined ? { unitScaleFactor: inspection.unitScaleFactor } : {}),
            ...(inspection.unitsMessage !== undefined ? { unitsMessage: inspection.unitsMessage } : {}),
            solids: inspection.solids!,
            ...(sourceUnit !== undefined ? { sourceUnit } : {})
        });
    }

    /** Detached source metadata carried by inspection results and import proposals. */
    protected importSourceMetadata(
        sourcePath: string,
        inspection: InspectImportSourceResult,
        sourceUnit: ImportSourceUnit | undefined
    ): NukeCadImportProposalDetails['source'] {
        const sourceFormat = inspection.sourceFormat ?? inferImportSourceFormat(sourcePath);
        return {
            path: sourcePath,
            sourceHash: inspection.sourceHash!,
            ...(inspection.sourceSize !== undefined ? { sourceSize: inspection.sourceSize } : {}),
            ...(sourceFormat !== undefined ? { sourceFormat } : {}),
            ...(inspection.fileUnit !== undefined ? { fileUnit: inspection.fileUnit } : {}),
            ...(inspection.effectiveUnit !== undefined ? { effectiveUnit: inspection.effectiveUnit } : {}),
            ...(inspection.unitScaleFactor !== undefined ? { unitScaleFactor: inspection.unitScaleFactor } : {}),
            ...(inspection.unitsMessage !== undefined ? { unitsMessage: inspection.unitsMessage } : {}),
            ...(sourceUnit !== undefined ? { sourceUnit } : {})
        };
    }

    /** Contextual warnings for an inspected source; material/selection are preview-only. */
    protected importSourceWarnings(
        documentPath: string,
        sourcePath: string,
        inspection: InspectImportSourceResult,
        options: { sourceUnit?: ImportSourceUnit; material?: string; selectedCount?: number }
    ): string[] {
        const warnings = [...(inspection.warnings ?? [])];
        if (!isInsideDirectory(path.dirname(documentPath), sourcePath)) {
            warnings.push(
                "The import source is outside the document folder; copy it into the document's .parts folder to keep the project portable."
            );
        }
        const detectedUnit = normalizeImportSourceUnit(inspection.fileUnit) ?? normalizeImportSourceUnit(inspection.effectiveUnit);
        if (options.sourceUnit === undefined && detectedUnit === undefined) {
            warnings.push('The source file unit is unknown; choose a source unit to avoid a scale mismatch.');
        }
        if (options.selectedCount !== undefined && inspection.solids !== undefined && options.selectedCount < inspection.solids.length) {
            warnings.push(
                `Importing ${options.selectedCount} of ${inspection.solids.length} source solids; the remaining solids are not included.`
            );
        }
        if (options.selectedCount !== undefined && options.material === undefined) {
            warnings.push('No material tag was set; OpenMC region placeholders will need a material before export.');
        }
        return [...new Set(warnings)];
    }

    /** Map a proposal from a different import/feature/sketch/topology scope to its apply capability. */
    protected wrongScopeApplyMessage(proposal: NukeCadProposal): string {
        if (isSketchProposal(proposal)) {
            return 'This proposal is a sketch change; apply it with nuke.cad.applySketchChange.';
        }
        if (isTopologyProposal(proposal)) {
            return 'This proposal is a topology change; apply it with nuke.cad.applyTopologyChange.';
        }
        if (isImportProposal(proposal)) {
            return 'This proposal is an import; apply it with nuke.cad.applyImportBodies.';
        }
        if (isAssemblyProposal(proposal)) {
            return 'This proposal is an assembly change; apply it with nuke.cad.applyAssemblyChange.';
        }
        if (isDrawingProposal(proposal)) {
            return 'This proposal is a drawing change; apply it with nuke.cad.applyDrawingChange.';
        }
        return 'This proposal is a feature change; apply it with nuke.cad.applyFeatureChange.';
    }

    protected async previewFeatureChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const model = this.stateManager.model;
        const document = this.store.document;
        const uri = this.store.uri;
        if (!model || !document || !uri) {
            return this.inactiveResult();
        }
        if (!model.result.success) {
            return { ok: false, message: 'Rebuild the active document successfully before previewing a change.' };
        }
        const documentPath = new URI(uri).path.toString();
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const changes = readFeatureParamChanges(input);
        if (!changes.ok) {
            return { ok: false, message: changes.message };
        }
        const prepared = prepareFeatureEdit(document, changes.changes);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        this.ghostPreview.clear();
        return this.runCandidateBuild(prepared.result.afterDocument, documentPath, context, async (build) => {
            const topologyError = compareBuild(model.result, build);
            if (topologyError) {
                return { ok: false, message: topologyError, warnings: build.warnings };
            }
            const before: Record<string, FeatureParams> = {};
            const after: Record<string, FeatureParams> = {};
            for (const edit of prepared.result.edits) {
                const beforeFeature = document.features.find((feature) => feature.id === edit.featureId);
                const afterFeature = prepared.result.afterDocument.features.find((feature) => feature.id === edit.featureId);
                if (!beforeFeature || !afterFeature) {
                    return { ok: false, message: `Feature '${edit.featureId}' disappeared while preparing the change.` };
                }
                before[edit.featureId] = { ...beforeFeature.params };
                after[edit.featureId] = { ...afterFeature.params };
            }
            if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
                return { ok: false, message: 'The document changed while the preview was building. Preview the change again.' };
            }
            const summary = summarize(prepared.result.edits);
            const impact = buildImpact(model.result, build);
            const parsedCandidate = await this.readCandidateTessellation(build.tessPath);
            const proposal = this.proposals.create({
                scope: 'features',
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: prepared.result.changes,
                edits: prepared.result.edits,
                before,
                after,
                impact,
                build: buildSummary(build)
            });
            if (parsedCandidate) {
                const diff = compareCandidateSolids(this.stateManager.solidSummaries, parsedCandidate);
                this.ghostPreview.show({
                    proposalId: proposal.id,
                    tessData: parsedCandidate,
                    ...diff
                });
            }
            void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
            return {
                ok: true,
                data: {
                    proposalId: proposal.id,
                    summary,
                    changes: proposal.changes,
                    impact,
                    build: buildSummary(build)
                },
                changeSet: {
                    id: proposal.id,
                    title: 'CAD feature change',
                    summary,
                    changes: proposal.changes,
                    applyCapability: APPLY_FEATURE_CHANGE_ID
                },
                warnings: build.warnings
            };
        });
    }

    /**
     * Write the detached candidate beside the source document, run one private
     * build, and delegate the review step. The document's region manifest is
     * copied beside the candidate so the build sees the same region identity as
     * the real document. The transient document, its region sidecar, and the
     * preview directory are always deleted.
     */
    protected async runCandidateBuild(
        candidate: NukeCadDocument,
        documentPath: string,
        context: NukeCapabilityContext,
        review: (build: GeometryBuildResult) => Promise<NukeCapabilityResult>
    ): Promise<NukeCapabilityResult> {
        const workspaceRoot = context.workspaceRoots[0];
        if (!workspaceRoot) {
            return { ok: false, message: 'A workspace root is required to run a CAD preview build.' };
        }

        const previewId = globalThis.crypto.randomUUID();
        const previewDirectory = path.join(workspaceRoot, ...PREVIEW_ROOT, previewId);
        // Keep the transient document beside the source so document-relative
        // imports resolve exactly as they do for the real document. Only the
        // build artifacts go to the private preview directory.
        const candidateStem = `.nuke-ai-preview-${previewId}`;
        const candidatePath = path.join(path.dirname(documentPath), `${candidateStem}.nuke-cad`);
        const candidateSidecarPath = `${candidatePath.slice(0, -'.nuke-cad'.length)}.regions.json`;
        const sourceSidecarPath = regionSidecarPath(documentPath);
        const jobId = `cad-ai-preview-${previewId}`;
        const abort = (): void => {
            void this.service.cancelJob(jobId);
        };
        context.signal?.addEventListener('abort', abort);
        try {
            if (sourceSidecarPath !== undefined) {
                let sourceExists: boolean;
                try {
                    sourceExists = await this.fileService.exists(new URI(sourceSidecarPath));
                } catch (error) {
                    return {
                        ok: false,
                        message: `The CAD region manifest '${sourceSidecarPath}' could not be inspected: ${errorMessage(error)}`
                    };
                }
                if (sourceExists) {
                    try {
                        const source = await this.fileService.readFile(new URI(sourceSidecarPath));
                        await this.fileService.create(new URI(candidateSidecarPath), source.value.toString());
                    } catch (error) {
                        return {
                            ok: false,
                            message: `The CAD region manifest '${sourceSidecarPath}' could not be copied for the preview: ${errorMessage(error)}`
                        };
                    }
                }
            }
            await this.fileService.create(new URI(candidatePath), JSON.stringify(candidate, null, 2));
            if (context.signal?.aborted) {
                return { ok: false, message: 'The CAD preview was cancelled.' };
            }
            const build = await this.service.buildDocument({
                scriptPath: candidatePath,
                outputDirectory: previewDirectory,
                useCache: false,
                jobId,
                timeoutSeconds: PREVIEW_TIMEOUT_SECONDS
            });
            if (!build.success) {
                return {
                    ok: false,
                    message: build.error || 'The preview build failed.',
                    warnings: build.warnings
                };
            }
            return await review(build);
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        } finally {
            context.signal?.removeEventListener('abort', abort);
            await Promise.all([
                this.fileService.delete(new URI(candidatePath), { recursive: false, useTrash: false }).catch(() => undefined),
                this.fileService
                    .delete(new URI(candidateSidecarPath), {
                        recursive: false,
                        useTrash: false
                    })
                    .catch(() => undefined),
                this.fileService.delete(new URI(previewDirectory), { recursive: true, useTrash: false }).catch(() => undefined)
            ]);
        }
    }

    /**
     * Read-only assembly metadata: instance placements and solved matrices,
     * selector solid ids, BOM quantities, connectors, mates, and grounding.
     */
    protected async summarizeAssembly(): Promise<NukeCapabilityResult> {
        const document = this.store.document;
        if (!document) {
            return this.inactiveResult();
        }
        const assembly = getAssemblySection(document);
        const instances: readonly AssemblyInstance[] = assembly?.instances ?? [];
        const transforms = assembly !== undefined ? solveAssemblyTransforms(assembly) : new Map();
        const selectorMap = this.stateManager.model?.result.selectorMap;
        const warnings: string[] = [];
        if (assembly === undefined || instances.length === 0) {
            warnings.push('This document has no assembly section.');
        } else if (!assembly.groundedInstanceId) {
            warnings.push('The assembly has no grounded instance.');
        }
        return {
            ok: true,
            data: {
                documentPath: this.activeDocumentPath() ?? '',
                hasAssembly: assembly !== undefined && instances.length > 0,
                groundedInstanceId: assembly?.groundedInstanceId ?? '',
                overlapCheck: document.overlapCheck !== false,
                instances: instances.map((instance) => ({
                    id: instance.id,
                    part: instance.part,
                    ...(instance.scale !== undefined ? { scale: instance.scale } : {}),
                    placement: instance.placement,
                    matrix: transforms.get(instance.id) ?? instancePlacementToMatrix(instance.placement),
                    solidIds: instanceSolidIds(selectorMap, instance.id)
                })),
                bom: assembly !== undefined ? assemblyBomQuantities(assembly) : [],
                connectors: (assembly?.connectors ?? []).map((connector) => ({
                    id: connector.id,
                    instanceId: connector.instanceId
                })),
                mates: (assembly?.mates ?? []).map((mate) => ({
                    id: mate.id,
                    type: mate.type,
                    instanceA: mate.instanceA,
                    instanceB: mate.instanceB
                })),
                warnings
            }
        };
    }

    /**
     * Read-only drawing metadata: sheet bounds, views, dimensions, and the
     * fixed title-block fields. No topology fingerprints are returned.
     */
    protected async summarizeDrawing(): Promise<NukeCapabilityResult> {
        const document = this.store.document;
        if (!document) {
            return this.inactiveResult();
        }
        const sheets = document.drawings ?? [];
        const warnings: string[] = [];
        if (sheets.length === 0) {
            warnings.push('This document has no drawing sheets.');
        }
        const model = this.stateManager.model;
        if (model !== undefined && !model.result.success) {
            warnings.push('The active CAD build failed; drawing values may be stale.');
        }
        const sheetRows = sheets.map((sheet) => {
            const bounds = DRAWING_SHEET_DIMENSIONS_MM[sheet.size];
            if (sheet.views.length === 0) {
                warnings.push(`Drawing sheet '${sheet.name}' has no views.`);
            }
            return {
                id: sheet.id,
                name: sheet.name,
                size: sheet.size,
                orientation: sheet.orientation,
                sheetSizeMm: { width: bounds.width, height: bounds.height },
                scaleLabel: drawingSheetScaleLabel(sheet)
            };
        });
        const views = sheets.flatMap((sheet) =>
            sheet.views.map((view) => {
                const bounds = DRAWING_SHEET_DIMENSIONS_MM[sheet.size];
                if (!isPointOnSheet(view.position, bounds.width, bounds.height)) {
                    warnings.push(`View '${view.id}' lies outside drawing sheet '${sheet.name}'.`);
                }
                return {
                    sheetId: sheet.id,
                    id: view.id,
                    kind: view.kind,
                    orientation: view.orientation,
                    scale: view.scale,
                    scaleLabel: formatDrawingScale(view.scale),
                    position: [view.position[0], view.position[1]] as [number, number],
                    ...(view.parentId !== undefined ? { parentId: view.parentId } : {}),
                    showHidden: view.showHidden === true
                };
            })
        );
        const dimensions = sheets.flatMap((sheet) =>
            sheet.dimensions.map((dimension) => ({
                sheetId: sheet.id,
                id: dimension.id,
                kind: dimension.kind,
                viewId: dimension.viewId,
                visible: dimension.hidden !== true,
                ...(dimension.value !== undefined ? { value: dimension.value } : {}),
                stale: dimension.stale === true,
                targetFeatureIds: [...new Set(dimension.targets.map((target) => target.featureId))],
                targetKinds: [...new Set(dimension.targets.map((target) => target.kind))]
            }))
        );
        const staleDimensions = dimensions.filter((dimension) => dimension.stale).map((dimension) => dimension.id);
        if (staleDimensions.length > 0) {
            warnings.push(`Stale drawing dimension(s): ${staleDimensions.join(', ')}.`);
        }
        const firstSheet = sheets[0];
        const titleBlock = {
            editable: false as const,
            fields: {
                documentName: document.name,
                sheetName: firstSheet?.name ?? '',
                size: firstSheet?.size ?? 'A4',
                orientation: firstSheet?.orientation ?? 'landscape',
                scaleLabel: firstSheet !== undefined ? drawingSheetScaleLabel(firstSheet) : '—',
                brand: 'NUKE CAD',
                product: 'NukeIDE'
            }
        };
        return {
            ok: true,
            data: {
                documentPath: this.activeDocumentPath() ?? '',
                hasDrawings: sheets.length > 0,
                drawingVersion: this.store.drawingVersion,
                sheets: sheetRows,
                views,
                dimensions,
                titleBlock,
                warnings
            },
            warnings
        };
    }

    /** Read-only sketch and dimension metadata for the active document. */
    protected async listSketchDimensions(): Promise<NukeCapabilityResult> {
        const document = this.store.document;
        if (!document) {
            return this.inactiveResult();
        }
        return {
            ok: true,
            data: {
                documentPath: this.activeDocumentPath() ?? '',
                parameters: { ...document.parameters },
                sketches: document.sketches.map((sketch) => ({
                    id: sketch.id,
                    name: sketch.name,
                    datumId: sketch.datumId,
                    consumedByFeatureIds: featuresConsumingSketch(document, sketch.id),
                    dimensions: (sketch.dimensions ?? []).map((dimension) => ({
                        id: dimension.id,
                        kind: dimension.kind,
                        driving: dimension.driving,
                        ...(dimension.parameter !== undefined ? { parameter: dimension.parameter } : {}),
                        value: dimension.value
                    }))
                }))
            }
        };
    }

    protected async previewSketchChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const model = this.stateManager.model;
        const document = this.store.document;
        const uri = this.store.uri;
        if (!model || !document || !uri) {
            return this.inactiveResult();
        }
        if (!model.result.success) {
            return { ok: false, message: 'Rebuild the active document successfully before previewing a change.' };
        }
        const documentPath = new URI(uri).path.toString();
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const requests = readSketchEditRequests(input);
        if (!requests.ok) {
            return { ok: false, message: requests.message };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        const prepared = await this.sketchEditService.prepare(document, requests.changes);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
            return { ok: false, message: 'The document changed while the sketch was solving. Preview the change again.' };
        }
        this.ghostPreview.clear();
        const sketch = prepared.result;
        return this.runCandidateBuild(sketch.afterDocument, documentPath, context, async (build) => {
            const topologyError = compareBuild(model.result, build);
            if (topologyError) {
                return { ok: false, message: topologyError, warnings: build.warnings };
            }
            if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
                return { ok: false, message: 'The document changed while the preview was building. Preview the change again.' };
            }
            const summary = summarizeSketchEdit(sketch);
            const impact = buildImpact(model.result, build);
            const parsedCandidate = await this.readCandidateTessellation(build.tessPath);
            const details = {
                targetSketchId: sketch.targetSketchId,
                targetSketchName: sketch.targetSketchName,
                affectedSketchIds: sketch.affectedSketchIds,
                affectedFeatureIds: sketch.affectedFeatureIds,
                beforeSketches: sketch.beforeSketches,
                afterSketches: sketch.afterSketches,
                beforeParameters: sketch.beforeParameters,
                afterParameters: sketch.afterParameters,
                solver: sketch.solver,
                edits: sketch.edits
            };
            const proposal = this.proposals.create({
                scope: 'sketch',
                applyCapability: APPLY_SKETCH_CHANGE_ID,
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: sketch.changes,
                impact,
                build: buildSummary(build),
                sketch: details
            });
            if (parsedCandidate) {
                const diff = compareCandidateSolids(this.stateManager.solidSummaries, parsedCandidate);
                this.ghostPreview.show({
                    proposalId: proposal.id,
                    tessData: parsedCandidate,
                    ...diff
                });
            }
            void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
            return {
                ok: true,
                data: {
                    proposalId: proposal.id,
                    summary,
                    changes: proposal.changes,
                    impact,
                    build: buildSummary(build),
                    sketch: details
                },
                changeSet: {
                    id: proposal.id,
                    title: 'CAD sketch dimension change',
                    summary,
                    changes: proposal.changes,
                    applyCapability: APPLY_SKETCH_CHANGE_ID
                },
                warnings: build.warnings
            };
        });
    }

    protected async previewTopologyChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const model = this.stateManager.model;
        const document = this.store.document;
        const uri = this.store.uri;
        if (!model || !document || !uri) {
            return this.inactiveResult();
        }
        if (!model.result.success) {
            return { ok: false, message: 'Rebuild the active document successfully before previewing a change.' };
        }
        const documentPath = new URI(uri).path.toString();
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const actions = readTopologyActions(input);
        if (!actions.ok) {
            return { ok: false, message: actions.message };
        }
        const prepared = prepareTopologyEdit(document, actions.actions);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        const candidateValidation = validateNukeCadDocument(prepared.result.afterDocument);
        if (!candidateValidation.valid) {
            const details = candidateValidation.issues
                .slice(0, 3)
                .map((issue) => `${issue.path || 'document'}: ${issue.message}`)
                .join('; ');
            return { ok: false, message: `The topology edit produced an invalid CAD document: ${details}` };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        this.ghostPreview.clear();
        return this.runCandidateBuild(prepared.result.afterDocument, documentPath, context, async (build) => {
            const validationError = validateTopologyCandidateBuild(build);
            if (validationError) {
                return { ok: false, message: validationError, warnings: build.warnings };
            }
            if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
                return { ok: false, message: 'The document changed while the preview was building. Preview the change again.' };
            }
            const parsedCandidate = await this.readCandidateTessellation(build.tessPath);
            const solidDiff = parsedCandidate
                ? compareCandidateSolids(this.stateManager.solidSummaries, parsedCandidate)
                : { addedSolidIds: [], removedSolidIds: [], changedSolidIds: [], changedBodyIds: [] };
            const beforeSnapshot: TopologyBuildSnapshot = {
                solidCount: model.result.solidCount ?? 0,
                faceCount: model.result.faceCount ?? 0,
                triangleCount: model.result.triangleCount ?? 0,
                selectorMap: model.result.selectorMap,
                regionManifest: model.result.regionManifest
            };
            const afterSnapshot: TopologyBuildSnapshot = {
                solidCount: build.solidCount ?? 0,
                faceCount: build.faceCount ?? 0,
                triangleCount: build.triangleCount ?? 0,
                selectorMap: build.selectorMap,
                regionManifest: build.regionManifest
            };
            const topologyImpact = diffTopology(beforeSnapshot, afterSnapshot, solidDiff);
            const afterRegions = buildTopologyRegions(afterSnapshot);
            const openmc = await readOpenmcRegionReferences(this.fileService, context.activeOpenmcProject);
            const blockedRegions = findOpenmcRegionBlockers(topologyImpact, afterRegions, openmc);
            const summary = summarizeTopologyEdit(document, prepared.result.edits);
            const sizeImpact = buildImpact(model.result, build);
            const proposal = this.proposals.create({
                scope: 'topology',
                applyCapability: APPLY_TOPOLOGY_CHANGE_ID,
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: prepared.result.changes,
                impact: sizeImpact,
                build: buildSummary(build),
                topology: {
                    actions: actions.actions,
                    before: Object.fromEntries(prepared.result.edits.map((edit) => [edit.featureId, edit.before])),
                    after: Object.fromEntries(prepared.result.edits.map((edit) => [edit.featureId, edit.after])),
                    topology: topologyImpact,
                    afterRegions,
                    blockedRegions,
                    openmcStatus: openmc.status,
                    ...(openmc.projectPath ? { openmcProjectPath: openmc.projectPath } : {}),
                    openmcWarnings: openmc.warnings
                }
            });
            if (parsedCandidate) {
                this.ghostPreview.show({
                    proposalId: proposal.id,
                    tessData: parsedCandidate,
                    ...solidDiff
                });
            }
            void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
            return {
                ok: true,
                data: {
                    proposalId: proposal.id,
                    summary,
                    changes: proposal.changes,
                    impact: sizeImpact,
                    regionImpact: topologyImpact,
                    blockedRegions,
                    openmcStatus: openmc.status,
                    openmcWarnings: openmc.warnings,
                    build: buildSummary(build)
                },
                changeSet: {
                    id: proposal.id,
                    title: 'CAD topology change',
                    summary,
                    changes: proposal.changes,
                    ...(blockedRegions.length === 0 ? { applyCapability: APPLY_TOPOLOGY_CHANGE_ID } : {})
                },
                warnings: [...(build.warnings ?? []), ...openmc.warnings]
            };
        });
    }

    protected async previewAssemblyChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const model = this.stateManager.model;
        const document = this.store.document;
        const uri = this.store.uri;
        if (!model || !document || !uri) {
            return this.inactiveResult();
        }
        if (!model.result.success) {
            return { ok: false, message: 'Rebuild the active document successfully before previewing a change.' };
        }
        const documentPath = new URI(uri).path.toString();
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const assembly = getAssemblySection(document);
        if (assembly === undefined || assembly.instances.length === 0 || assembly.groundedInstanceId.length === 0) {
            return {
                ok: false,
                message: 'Open a .nuke-cad document with a grounded assembly before previewing an assembly change.'
            };
        }
        const actions = readAssemblyActions(input);
        if (!actions.ok) {
            return { ok: false, message: actions.message };
        }
        const prepared = prepareAssemblyEdit(document, actions.actions);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        this.ghostPreview.clear();
        return this.runCandidateBuild(prepared.result.afterDocument, documentPath, context, async (build) => {
            const validationError = validateAssemblyCandidateBuild(build, prepared.result.afterSection, document);
            if (validationError) {
                return { ok: false, message: validationError, warnings: build.warnings };
            }
            if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
                return { ok: false, message: 'The document changed while the preview was building. Preview the change again.' };
            }
            const parsedCandidate = await this.readCandidateTessellation(build.tessPath);
            const solidDiff = parsedCandidate
                ? compareCandidateSolids(this.stateManager.solidSummaries, parsedCandidate)
                : { addedSolidIds: [], removedSolidIds: [], changedSolidIds: [], changedBodyIds: [] };
            const collisionWarnings = assemblyCollisionWarnings(build.warnings, document.overlapCheck !== false);
            const openmc = await readOpenmcRegionReferences(this.fileService, context.activeOpenmcProject);
            const beforeAssembly = assembly;
            const beforeBom = assemblyBomQuantities(beforeAssembly);
            const afterBom = assemblyBomQuantities(prepared.result.afterSection);
            let removedRegions: readonly AssemblyRemovedRegion[] = prepared.result.removedRegions.map((region) => ({
                ...region,
                solidIds: [...region.solidIds]
            }));
            let blockedRegions: readonly OpenmcRegionBlocker[] = [];
            if (prepared.result.requiresAcknowledgement) {
                const beforeLabelMap = assemblyLabelSolidMap(model.result.selectorMap, beforeAssembly, document);
                const afterLabelMap = assemblyLabelSolidMap(build.selectorMap, prepared.result.afterSection, document);
                removedRegions = removedRegions.map((region) => ({
                    ...region,
                    solidIds: beforeLabelMap[region.selector] ?? region.solidIds
                }));
                const afterRegions = buildTopologyRegions({
                    solidCount: build.solidCount ?? 0,
                    faceCount: build.faceCount ?? 0,
                    triangleCount: build.triangleCount ?? 0,
                    selectorMap: afterLabelMap,
                    regionManifest: build.regionManifest
                });
                blockedRegions = findOpenmcRegionBlockers(
                    { removedRegions: removedRegions.map(removedRegionRef), changedRegions: [] },
                    afterRegions,
                    openmc
                );
            }
            const placements = prepared.result.placements.map((plan) => ({
                ...plan,
                ...(plan.before !== undefined
                    ? {
                          before: {
                              ...plan.before,
                              solidIds: instanceSolidIds(model.result.selectorMap, plan.instanceId)
                          }
                      }
                    : {}),
                ...(plan.after !== undefined
                    ? {
                          after: {
                              ...plan.after,
                              solidIds: instanceSolidIds(build.selectorMap, plan.instanceId)
                          }
                      }
                    : {})
            }));
            const summary = summarizeAssemblyActions(actions.actions);
            const impact = buildImpact(model.result, build);
            const warnings = uniqueStrings([
                ...prepared.result.warnings,
                ...collisionWarnings,
                ...openmc.warnings,
                ...(build.warnings ?? [])
            ]);
            const details: NukeCadAssemblyProposalDetails = {
                actions: actions.actions,
                before: {
                    instances: beforeAssembly.instances,
                    groundedInstanceId: beforeAssembly.groundedInstanceId,
                    bom: beforeBom
                },
                after: {
                    instances: prepared.result.afterSection.instances,
                    groundedInstanceId: prepared.result.afterSection.groundedInstanceId,
                    bom: afterBom
                },
                placements,
                bomDelta: prepared.result.bomDelta,
                warnings: prepared.result.warnings,
                collisionWarnings,
                overlapCheck: document.overlapCheck !== false,
                removedSelectorKeys: prepared.result.removedSelectorKeys,
                removedRegions,
                blockedRegions,
                openmcStatus: openmc.status,
                ...(openmc.projectPath ? { openmcProjectPath: openmc.projectPath } : {}),
                openmcWarnings: openmc.warnings,
                requiresAcknowledgement: prepared.result.requiresAcknowledgement
            };
            const proposal = this.proposals.create({
                scope: 'assembly',
                applyCapability: APPLY_ASSEMBLY_CHANGE_ID,
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: prepared.result.changes,
                impact,
                build: buildSummary(build),
                assembly: details
            });
            if (parsedCandidate) {
                this.ghostPreview.show({
                    proposalId: proposal.id,
                    tessData: parsedCandidate,
                    ...solidDiff
                });
            }
            void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
            return {
                ok: true,
                data: {
                    proposalId: proposal.id,
                    summary,
                    changes: proposal.changes,
                    impact,
                    assembly: details,
                    blockedRegions,
                    openmcStatus: openmc.status,
                    openmcWarnings: openmc.warnings,
                    warnings,
                    build: buildSummary(build)
                },
                changeSet: {
                    id: proposal.id,
                    title: 'CAD assembly change',
                    summary,
                    changes: proposal.changes,
                    ...(blockedRegions.length === 0 ? { applyCapability: APPLY_ASSEMBLY_CHANGE_ID } : {})
                },
                warnings
            };
        });
    }

    /** Read and parse the candidate tessellation before the temp directory is deleted. */
    protected async readCandidateTessellation(
        tessPath: string | undefined
    ): Promise<Awaited<ReturnType<typeof parseTessellationAsync>> | undefined> {
        if (!tessPath) {
            return undefined;
        }
        try {
            const content = await this.fileService.readFile(new URI(tessPath));
            return await parseTessellationAsync(content.value.toString());
        } catch (error) {
            console.warn('[NukeCadAuthoring] Candidate tessellation could not be parsed:', error);
            return undefined;
        }
    }

    protected async applyAssemblyChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const proposalId = readProposalId(input);
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        if (!isAssemblyProposal(proposal)) {
            return { ok: false, message: this.wrongScopeApplyMessage(proposal) };
        }
        if (proposal.assembly.requiresAcknowledgement && !acknowledgesRegionChanges(input)) {
            return { ok: false, message: 'Acknowledge the region impact before applying this assembly change.' };
        }
        const firstBlocker = proposal.assembly.blockedRegions[0];
        if (firstBlocker) {
            return {
                ok: false,
                message: `This assembly change would break a saved OpenMC reference: ${firstBlocker.message}`
            };
        }
        const stale = this.assemblyStaleReason(proposal);
        if (stale) {
            return { ok: false, message: stale };
        }
        const document = this.store.document;
        if (!document) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        const replanned = prepareAssemblyEdit(document, proposal.assembly.actions);
        if (!replanned.ok) {
            return { ok: false, message: replanned.message };
        }
        const currentAssembly = getAssemblySection(document);
        if (currentAssembly === undefined) {
            return { ok: false, message: 'The assembly section disappeared after this preview. Preview the change again.' };
        }
        const expectedAfterSection = {
            ...currentAssembly,
            instances: proposal.assembly.after.instances,
            groundedInstanceId: proposal.assembly.after.groundedInstanceId
        };
        // Proposal storage is JSON-detached, so `undefined` fields (such as a
        // removal's `after`) are dropped; normalize the re-planned diff the
        // same way before comparing.
        const replannedChanges = JSON.parse(JSON.stringify(replanned.result.changes)) as unknown;
        if (
            stableStringify(replanned.result.afterSection) !== stableStringify(expectedAfterSection) ||
            stableStringify(replannedChanges) !== stableStringify(proposal.changes)
        ) {
            return { ok: false, message: 'The assembly changed after this preview. Preview the change again.' };
        }
        if (proposal.assembly.requiresAcknowledgement) {
            if (context.activeOpenmcProject !== proposal.assembly.openmcProjectPath) {
                return { ok: false, message: 'The active OpenMC project changed after this preview. Preview the change again.' };
            }
            const openmc = await readOpenmcRegionReferences(this.fileService, context.activeOpenmcProject);
            if (proposal.assembly.openmcProjectPath !== undefined && openmc.status !== 'saved-project') {
                return {
                    ok: false,
                    message: 'The saved OpenMC project can no longer be re-checked. Restore the project file and preview the change again.'
                };
            }
            const model = this.stateManager.model;
            const afterLabelMap = assemblyLabelSolidMap(model?.result.selectorMap, replanned.result.afterSection, document);
            const modelManifest = model?.result.regionManifest;
            const afterRegions = buildTopologyRegions({
                solidCount: model?.result.solidCount ?? 0,
                faceCount: model?.result.faceCount ?? 0,
                triangleCount: model?.result.triangleCount ?? 0,
                selectorMap: afterLabelMap,
                // The live manifest still covers removed labels; keep only
                // volumes whose label survives so the re-check cannot be
                // satisfied by a stale region entry.
                regionManifest:
                    modelManifest !== undefined
                        ? {
                              ...modelManifest,
                              volumes: modelManifest.volumes.filter((volume) => volume.selector in afterLabelMap)
                          }
                        : undefined
            });
            const blockers = findOpenmcRegionBlockers(
                { removedRegions: proposal.assembly.removedRegions.map(removedRegionRef), changedRegions: [] },
                afterRegions,
                openmc
            );
            if (blockers.length > 0) {
                return {
                    ok: false,
                    message: `This assembly change would break saved OpenMC references: ${blockers.map((blocker) => blocker.message).join(' ')}`
                };
            }
        }
        const backupPath = path.join(path.dirname(proposal.documentPath), `.nuke-ai-backup-${path.basename(proposal.documentPath)}`);
        try {
            const snapshot = this.store.toJson();
            if (!snapshot) {
                return { ok: false, message: 'The active CAD document could not be read for a backup.' };
            }
            await this.fileService.create(new URI(backupPath), snapshot, { overwrite: true });
        } catch (error) {
            return { ok: false, message: `Could not write the pre-apply CAD backup: ${errorMessage(error)}` };
        }
        const applied = this.store.applyAssemblyChanges({ actions: proposal.assembly.actions });
        if (!applied.success) {
            return {
                ok: false,
                message: applied.error || 'The CAD document rejected the assembly change.',
                warnings: formatIssues(applied.issues)
            };
        }
        const appliedRevision = this.store.revision;
        const removedInstanceIds = applied.value?.removedInstanceIds ?? replanned.result.removedInstanceIds;
        const addedInstanceIds = applied.value?.instanceIds ?? replanned.result.addedInstanceIds;
        this.proposals.remove(proposal.id);
        if (removedInstanceIds.length > 0) {
            this.clearAssemblySelection();
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD assembly change',
            undo: () => this.undoAssemblyChange(proposal, appliedRevision)
        });
        return {
            ok: true,
            message: 'CAD assembly change applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                addedInstanceIds,
                removedInstanceIds,
                groundedInstanceId: applied.value?.groundedInstanceId ?? replanned.result.afterSection.groundedInstanceId,
                rebuildScheduled: true,
                changes: proposal.changes,
                regionImpact: {
                    removedRegions: proposal.assembly.removedRegions,
                    removedSelectorKeys: proposal.assembly.removedSelectorKeys,
                    requiresAcknowledgement: proposal.assembly.requiresAcknowledgement
                }
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD assembly change',
                summary: proposal.summary,
                changes: proposal.changes
            },
            undoToken
        };
    }

    protected async undoAssemblyChange(proposal: NukeCadAssemblyProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
        if (!this.hasActiveDocument()) {
            return { ok: false, message: 'Open the document again before undoing this change.' };
        }
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return { ok: false, message: 'This change belongs to a different document and can no longer be undone.' };
        }
        if (this.store.revision !== appliedRevision) {
            return { ok: false, message: 'The document changed after this edit. Preview the change again.' };
        }
        const result = this.store.undo();
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        if (proposal.assembly.removedRegions.length > 0 || proposal.assembly.actions.some((action) => action.action === 'removeInstance')) {
            this.clearAssemblySelection();
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD assembly change undone.' };
    }

    protected assemblyStaleReason(proposal: NukeCadAssemblyProposal): string | undefined {
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return 'The active document changed after this preview. Preview the change again.';
        }
        if (this.store.revision !== proposal.baseRevision) {
            return 'The document changed after this preview. Preview the change again.';
        }
        return undefined;
    }

    /** Clear document and viewport selection after instances disappear. */
    protected clearAssemblySelection(): void {
        this.store.selectBody(undefined);
        this.store.clearSelection();
        this.stateManager.setSelection({});
    }

    /**
     * Plan drawing-sheet settings with the pure planner.
     *
     * No geometry build, temporary files, or ghost preview run: drawings are
     * derived linework, so the proposal only needs the sheet/view/dimension
     * rows the store will later apply in one drawing commit.
     */
    protected async previewDrawingChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const document = this.store.document;
        const documentPath = this.activeDocumentPath();
        if (!document || !documentPath) {
            return this.inactiveResult();
        }
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const parsed = readDrawingChangeActions(input);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }
        const prepared = prepareDrawingEdit(document, parsed.actions);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        this.ghostPreview.clear();
        const details = drawingProposalDetails(prepared.result);
        const summary = summarizeDrawingEdit(prepared.result);
        const proposal = this.proposals.create({
            scope: 'drawing',
            applyCapability: APPLY_DRAWING_CHANGE_ID,
            summary,
            documentPath,
            documentEpoch: baseEpoch,
            baseRevision,
            changes: prepared.result.changes,
            drawing: details
        });
        void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
        return {
            ok: true,
            data: {
                proposalId: proposal.id,
                summary,
                changes: proposal.changes,
                drawing: details,
                warnings: details.warnings
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD drawing change',
                summary,
                changes: proposal.changes,
                applyCapability: APPLY_DRAWING_CHANGE_ID
            },
            warnings: details.warnings
        };
    }

    /**
     * Commit a previewed drawing change in one `applyDrawingChanges` batch.
     *
     * The planner is re-run against the live document and its sheet, view,
     * dimension, and change rows must still match the preview exactly. A backup
     * is written before the commit, the Drawing Sheet is opened and refreshed
     * for the affected sheet, and geometry is never rebuilt.
     */
    protected async applyDrawingChange(input: unknown): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const proposalId = readProposalId(input);
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        if (!isDrawingProposal(proposal)) {
            return { ok: false, message: this.wrongScopeApplyMessage(proposal) };
        }
        const stale = this.drawingStaleReason(proposal);
        if (stale) {
            return { ok: false, message: stale };
        }
        const document = this.store.document;
        if (!document) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        const replanned = prepareDrawingEdit(document, proposal.drawing.actions);
        if (!replanned.ok) {
            return { ok: false, message: replanned.message };
        }
        const current = drawingProposalDetails(replanned.result);
        // Proposal storage is JSON-detached; normalize the re-planned changes
        // the same way before comparing so dropped `undefined` fields cannot
        // fake a drift.
        const replannedChanges = JSON.parse(JSON.stringify(replanned.result.changes)) as unknown;
        if (
            stableStringify(current.sheet) !== stableStringify(proposal.drawing.sheet) ||
            stableStringify(current.viewChanges) !== stableStringify(proposal.drawing.viewChanges) ||
            stableStringify(current.dimensionChanges) !== stableStringify(proposal.drawing.dimensionChanges) ||
            stableStringify(replannedChanges) !== stableStringify(proposal.changes)
        ) {
            return { ok: false, message: 'The drawing changed after this preview. Preview the change again.' };
        }
        const backupPath = path.join(path.dirname(proposal.documentPath), `.nuke-ai-backup-${path.basename(proposal.documentPath)}`);
        try {
            const snapshot = this.store.toJson();
            if (!snapshot) {
                return { ok: false, message: 'The active CAD document could not be read for a backup.' };
            }
            await this.fileService.create(new URI(backupPath), snapshot, { overwrite: true });
        } catch (error) {
            return { ok: false, message: `Could not write the pre-apply CAD backup: ${errorMessage(error)}` };
        }
        const applied = this.store.applyDrawingChanges({ actions: proposal.drawing.actions });
        if (!applied.success) {
            return {
                ok: false,
                message: applied.error || 'The CAD document rejected the drawing change.',
                warnings: formatIssues(applied.issues)
            };
        }
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        this.openAndRefreshDrawingSheet(proposal.drawing.sheet.id);
        const undoToken = this.undoService.register({
            title: 'CAD drawing change',
            undo: () => this.undoDrawingChange(proposal, appliedRevision)
        });
        return {
            ok: true,
            message: 'CAD drawing change applied; drawing refresh scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                sheetId: proposal.drawing.sheet.id,
                revision: appliedRevision,
                backupPath,
                drawingRefreshScheduled: true,
                geometryRebuildScheduled: false,
                changes: proposal.changes
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD drawing change',
                summary: proposal.summary,
                changes: proposal.changes
            },
            undoToken
        };
    }

    protected async undoDrawingChange(proposal: NukeCadDrawingProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
        if (!this.hasActiveDocument()) {
            return { ok: false, message: 'Open the document again before undoing this change.' };
        }
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return { ok: false, message: 'This change belongs to a different document and can no longer be undone.' };
        }
        if (this.store.revision !== appliedRevision) {
            return { ok: false, message: 'The document changed after this edit. Preview the change again.' };
        }
        const result = this.store.undo();
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        this.openAndRefreshDrawingSheet(proposal.drawing.sheet.id);
        return { ok: true, message: 'CAD drawing change undone.' };
    }

    protected drawingStaleReason(proposal: NukeCadDrawingProposal): string | undefined {
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return 'The active document changed after this preview. Preview the change again.';
        }
        if (this.store.revision !== proposal.baseRevision) {
            return 'The document changed after this preview. Preview the change again.';
        }
        return undefined;
    }

    /** Open the Drawing Sheet and rebuild only the affected sheet's linework. */
    protected openAndRefreshDrawingSheet(sheetId: string): void {
        void this.commands.executeCommand(NukeCadCommands.OPEN_DRAWING_SHEET.id).catch(() => undefined);
        void this.commands.executeCommand(NukeCadCommands.REFRESH_DRAWING_SHEET.id, sheetId).catch(() => undefined);
    }

    protected async applyFeatureChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const proposalId = readProposalId(input);
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        if (isSketchProposal(proposal)) {
            return { ok: false, message: 'This proposal is a sketch change; apply it with nuke.cad.applySketchChange.' };
        }
        if (isTopologyProposal(proposal)) {
            return { ok: false, message: 'This proposal is a topology change; apply it with nuke.cad.applyTopologyChange.' };
        }
        if (isImportProposal(proposal)) {
            return { ok: false, message: 'This proposal is an import; apply it with nuke.cad.applyImportBodies.' };
        }
        if (isAssemblyProposal(proposal)) {
            return { ok: false, message: 'This proposal is an assembly change; apply it with nuke.cad.applyAssemblyChange.' };
        }
        if (isDrawingProposal(proposal)) {
            return { ok: false, message: 'This proposal is a drawing change; apply it with nuke.cad.applyDrawingChange.' };
        }
        const stale = this.staleReason(proposal);
        if (stale) {
            return { ok: false, message: stale };
        }
        const backupPath = path.join(path.dirname(proposal.documentPath), `.nuke-ai-backup-${path.basename(proposal.documentPath)}`);
        try {
            const snapshot = this.store.toJson();
            if (!snapshot) {
                return { ok: false, message: 'The active CAD document could not be read for a backup.' };
            }
            await this.fileService.create(new URI(backupPath), snapshot, { overwrite: true });
        } catch (error) {
            return { ok: false, message: `Could not write the pre-apply CAD backup: ${errorMessage(error)}` };
        }
        const result = this.store.updateFeatureParamsBatch(Object.entries(proposal.after).map(([id, params]) => ({ id, params })));
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the change.', warnings: formatIssues(result.issues) };
        }
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD feature change',
            undo: () => this.undoFeatureChange(proposal, appliedRevision)
        });
        const changeSet = {
            id: proposal.id,
            title: 'CAD feature change',
            summary: proposal.summary,
            changes: proposal.changes
        };
        return {
            ok: true,
            message: 'CAD feature change applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                changes: proposal.changes,
                rebuildScheduled: true
            },
            changeSet,
            undoToken
        };
    }

    protected async undoFeatureChange(proposal: NukeCadFeatureProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
        if (!this.hasActiveDocument()) {
            return { ok: false, message: 'Open the document again before undoing this change.' };
        }
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return { ok: false, message: 'This change belongs to a different document and can no longer be undone.' };
        }
        if (this.store.revision !== appliedRevision) {
            return { ok: false, message: 'The document changed after this edit. Preview the change again.' };
        }
        const current = this.store.document;
        if (!current) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        for (const [id, params] of Object.entries(proposal.after)) {
            const feature = current.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(params)) {
                return { ok: false, message: 'The edited feature changed after apply. Preview the change again.' };
            }
        }
        const result = this.store.updateFeatureParamsBatch(Object.entries(proposal.before).map(([id, params]) => ({ id, params })));
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD change undone.' };
    }

    protected staleReason(proposal: NukeCadFeatureProposal): string | undefined {
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return 'The active document changed after this preview. Preview the change again.';
        }
        if (this.store.revision !== proposal.baseRevision) {
            return 'The document changed after this preview. Preview the change again.';
        }
        const document = this.store.document;
        if (!document) {
            return 'No CAD document is active.';
        }
        for (const [id, before] of Object.entries(proposal.before)) {
            const feature = document.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(before)) {
                return `Feature '${id}' changed after this preview. Preview the change again.`;
            }
        }
        return undefined;
    }

    protected async applySketchChange(input: unknown): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const proposalId = readProposalId(input);
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        if (isTopologyProposal(proposal)) {
            return { ok: false, message: 'This proposal is a topology change; apply it with nuke.cad.applyTopologyChange.' };
        }
        if (isImportProposal(proposal)) {
            return { ok: false, message: 'This proposal is an import; apply it with nuke.cad.applyImportBodies.' };
        }
        if (isAssemblyProposal(proposal)) {
            return { ok: false, message: 'This proposal is an assembly change; apply it with nuke.cad.applyAssemblyChange.' };
        }
        if (isDrawingProposal(proposal)) {
            return { ok: false, message: 'This proposal is a drawing change; apply it with nuke.cad.applyDrawingChange.' };
        }
        if (!isSketchProposal(proposal)) {
            return { ok: false, message: 'This proposal is a feature change; apply it with nuke.cad.applyFeatureChange.' };
        }
        const stale = this.sketchStaleReason(proposal);
        if (stale) {
            return { ok: false, message: stale };
        }
        const backupPath = path.join(path.dirname(proposal.documentPath), `.nuke-ai-backup-${path.basename(proposal.documentPath)}`);
        try {
            const snapshot = this.store.toJson();
            if (!snapshot) {
                return { ok: false, message: 'The active CAD document could not be read for a backup.' };
            }
            await this.fileService.create(new URI(backupPath), snapshot, { overwrite: true });
        } catch (error) {
            return { ok: false, message: `Could not write the pre-apply CAD backup: ${errorMessage(error)}` };
        }
        const result = this.store.applySketchAuthoringEdit({
            sketches: Object.values(proposal.sketch.afterSketches),
            parameters: proposal.sketch.afterParameters
        });
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the change.', warnings: formatIssues(result.issues) };
        }
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD sketch dimension change',
            undo: () => this.undoSketchChange(proposal, appliedRevision)
        });
        return {
            ok: true,
            message: 'CAD sketch change applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                changes: proposal.changes,
                rebuildScheduled: true,
                affectedFeatureIds: proposal.sketch.affectedFeatureIds
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD sketch dimension change',
                summary: proposal.summary,
                changes: proposal.changes,
                applyCapability: APPLY_SKETCH_CHANGE_ID
            },
            undoToken
        };
    }

    protected async undoSketchChange(proposal: NukeCadSketchProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
        if (!this.hasActiveDocument()) {
            return { ok: false, message: 'Open the document again before undoing this change.' };
        }
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return { ok: false, message: 'This change belongs to a different document and can no longer be undone.' };
        }
        if (this.store.revision !== appliedRevision) {
            return { ok: false, message: 'The document changed after this edit. Preview the change again.' };
        }
        const current = this.store.document;
        if (!current) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        for (const [id, after] of Object.entries(proposal.sketch.afterSketches)) {
            const currentSketch = current.sketches.find((candidate) => candidate.id === id);
            if (!sketchDefinitionsEqual(persistedSketch(currentSketch), persistedSketch(after))) {
                return { ok: false, message: `Sketch '${id}' changed after apply. Preview the change again.` };
            }
        }
        for (const [name, after] of Object.entries(proposal.sketch.afterParameters)) {
            if (current.parameters[name] !== after) {
                return { ok: false, message: `Parameter '${name}' changed after apply. Preview the change again.` };
            }
        }
        const result = this.store.applySketchAuthoringEdit({
            sketches: Object.values(proposal.sketch.beforeSketches),
            parameters: proposal.sketch.beforeParameters
        });
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD sketch change undone.' };
    }

    protected async applyTopologyChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const proposalId = readProposalId(input);
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }
        if (!acknowledgesRegionChanges(input)) {
            return { ok: false, message: 'Acknowledge the region impact before applying this topology change.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        if (!isTopologyProposal(proposal)) {
            return {
                ok: false,
                message: isSketchProposal(proposal)
                    ? 'This proposal is a sketch change; apply it with nuke.cad.applySketchChange.'
                    : isImportProposal(proposal)
                      ? 'This proposal is an import; apply it with nuke.cad.applyImportBodies.'
                      : isAssemblyProposal(proposal)
                        ? 'This proposal is an assembly change; apply it with nuke.cad.applyAssemblyChange.'
                        : isDrawingProposal(proposal)
                          ? 'This proposal is a drawing change; apply it with nuke.cad.applyDrawingChange.'
                          : 'This proposal is a feature change; apply it with nuke.cad.applyFeatureChange.'
            };
        }
        const firstBlocker = proposal.topology.blockedRegions[0];
        if (firstBlocker) {
            return {
                ok: false,
                message: `This topology change would break a saved OpenMC reference: ${firstBlocker.message}`
            };
        }
        if (context.activeOpenmcProject !== proposal.topology.openmcProjectPath) {
            return { ok: false, message: 'The active OpenMC project changed after this preview. Preview the change again.' };
        }
        const openmc = await readOpenmcRegionReferences(this.fileService, context.activeOpenmcProject);
        if (proposal.topology.openmcProjectPath !== undefined && openmc.status !== 'saved-project') {
            return {
                ok: false,
                message: 'The saved OpenMC project can no longer be re-checked. Restore the project file and preview the change again.'
            };
        }
        const blockers = findOpenmcRegionBlockers(proposal.topology.topology, proposal.topology.afterRegions, openmc);
        if (blockers.length > 0) {
            return {
                ok: false,
                message: `This topology change would break saved OpenMC references: ${blockers.map((blocker) => blocker.message).join(' ')}`
            };
        }
        const stale = this.topologyStaleReason(proposal);
        if (stale) {
            return { ok: false, message: stale };
        }
        const backupPath = path.join(path.dirname(proposal.documentPath), `.nuke-ai-backup-${path.basename(proposal.documentPath)}`);
        try {
            const snapshot = this.store.toJson();
            if (!snapshot) {
                return { ok: false, message: 'The active CAD document could not be read for a backup.' };
            }
            await this.fileService.create(new URI(backupPath), snapshot, { overwrite: true });
        } catch (error) {
            return { ok: false, message: `Could not write the pre-apply CAD backup: ${errorMessage(error)}` };
        }
        const result = this.store.replaceFeatureParamsBatch(
            Object.entries(proposal.topology.after).map(([id, params]) => ({ id, params }))
        );
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the change.', warnings: formatIssues(result.issues) };
        }
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD topology change',
            undo: () => this.undoTopologyChange(proposal, appliedRevision)
        });
        return {
            ok: true,
            message: 'CAD topology change applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                changes: proposal.changes,
                rebuildScheduled: true,
                regionImpact: proposal.topology.topology
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD topology change',
                summary: proposal.summary,
                changes: proposal.changes,
                applyCapability: APPLY_TOPOLOGY_CHANGE_ID
            },
            undoToken
        };
    }

    protected async undoTopologyChange(proposal: NukeCadTopologyProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
        if (!this.hasActiveDocument()) {
            return { ok: false, message: 'Open the document again before undoing this change.' };
        }
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return { ok: false, message: 'This change belongs to a different document and can no longer be undone.' };
        }
        if (this.store.revision !== appliedRevision) {
            return { ok: false, message: 'The document changed after this edit. Preview the change again.' };
        }
        const current = this.store.document;
        if (!current) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        for (const [id, after] of Object.entries(proposal.topology.after)) {
            const feature = current.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(after)) {
                return { ok: false, message: `Feature '${id}' changed after apply. Preview the change again.` };
            }
        }
        const result = this.store.replaceFeatureParamsBatch(
            Object.entries(proposal.topology.before).map(([id, params]) => ({ id, params }))
        );
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD topology change undone.' };
    }

    protected topologyStaleReason(proposal: NukeCadTopologyProposal): string | undefined {
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return 'The active document changed after this preview. Preview the change again.';
        }
        if (this.store.revision !== proposal.baseRevision) {
            return 'The document changed after this preview. Preview the change again.';
        }
        const document = this.store.document;
        if (!document) {
            return 'No CAD document is active.';
        }
        for (const [id, before] of Object.entries(proposal.topology.before)) {
            const feature = document.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(before)) {
                return `Feature '${id}' changed after this preview. Preview the change again.`;
            }
        }
        return undefined;
    }

    protected sketchStaleReason(proposal: NukeCadSketchProposal): string | undefined {
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return 'The active document changed after this preview. Preview the change again.';
        }
        if (this.store.revision !== proposal.baseRevision) {
            return 'The document changed after this preview. Preview the change again.';
        }
        const document = this.store.document;
        if (!document) {
            return 'No CAD document is active.';
        }
        for (const [name, before] of Object.entries(proposal.sketch.beforeParameters)) {
            if (document.parameters[name] !== before) {
                return `Parameter '${name}' changed after this preview. Preview the change again.`;
            }
        }
        for (const [id, before] of Object.entries(proposal.sketch.beforeSketches)) {
            const sketch = document.sketches.find((candidate) => candidate.id === id);
            if (!sketchDefinitionsEqual(sketch, before)) {
                return `Sketch '${id}' changed after this preview. Preview the change again.`;
            }
        }
        return undefined;
    }

    protected scopeError(documentPath: string, workspaceRoots: readonly string[]): string | undefined {
        if (!path.isAbsolute(documentPath)) {
            return 'The active CAD document path must be absolute.';
        }
        if (!isWithinWorkspace(documentPath, workspaceRoots)) {
            return 'The active CAD document is outside every workspace root.';
        }
        return undefined;
    }
}

/** Read and shape-check the preview input; semantic checks live in the pure engine. */
export function readFeatureParamChanges(
    input: unknown
): { ok: true; changes: readonly FeatureParamChange[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: 'changes must contain 1 to 16 feature edits.' };
    }
    if (raw.length > CAD_FEATURE_EDIT_LIMIT) {
        return { ok: false, message: `changes must contain at most ${CAD_FEATURE_EDIT_LIMIT} feature edits.` };
    }
    const changes: FeatureParamChange[] = [];
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: 'Each change must be an object.' };
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.featureId !== 'string' || record.featureId.length === 0) {
            return { ok: false, message: 'Each change needs a non-empty featureId.' };
        }
        if (
            record.param !== 'length' &&
            record.param !== 'angle' &&
            record.param !== 'radius' &&
            record.param !== 'thickness' &&
            record.param !== 'distance' &&
            record.param !== 'spacing' &&
            record.param !== 'diameter' &&
            record.param !== 'depth'
        ) {
            return { ok: false, message: `Unsupported feature parameter '${String(record.param)}'.` };
        }
        if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
            return { ok: false, message: `Feature '${record.featureId}' needs a finite numeric value.` };
        }
        changes.push({ featureId: record.featureId, param: record.param as EditableFeatureParam, value: record.value });
    }
    return { ok: true, changes };
}

/** Shape-checked import-source inspection input. */
export function readInspectImportSourceInput(
    input: unknown
): { ok: true; sourcePath?: string; sourceUnit?: ImportSourceUnit } | { ok: false; message: string } {
    if (input === undefined) {
        return { ok: true };
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'Import inspection input must be an object.' };
    }
    const record = input as Record<string, unknown>;
    const sourcePath = record.sourcePath;
    if (sourcePath !== undefined && (typeof sourcePath !== 'string' || sourcePath.trim().length === 0)) {
        return { ok: false, message: 'sourcePath must be a non-empty absolute path when provided.' };
    }
    const sourceUnit = record.sourceUnit;
    if (sourceUnit !== undefined && !isImportSourceUnit(sourceUnit)) {
        return { ok: false, message: "sourceUnit must be 'mm', 'cm', or 'm' when provided." };
    }
    return {
        ok: true,
        ...(sourcePath !== undefined ? { sourcePath } : {}),
        ...(sourceUnit !== undefined ? { sourceUnit } : {})
    };
}

/** Shape-checked imported-body preview input. */
export function readImportPreviewInput(input: unknown):
    | {
          ok: true;
          sourcePath: string;
          strategy: 'single' | 'perSolid';
          label: string;
          solidIndexes: readonly number[];
          sourceUnit?: ImportSourceUnit;
          material?: string;
      }
    | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'Import preview input must be an object.' };
    }
    const record = input as Record<string, unknown>;
    if (typeof record.sourcePath !== 'string' || record.sourcePath.trim().length === 0) {
        return { ok: false, message: 'sourcePath is required.' };
    }
    if (record.strategy !== 'single' && record.strategy !== 'perSolid') {
        return { ok: false, message: "strategy must be 'single' or 'perSolid'." };
    }
    if (typeof record.label !== 'string' || record.label.trim().length === 0) {
        return { ok: false, message: 'Enter a body label.' };
    }
    const solidIndexes = record.solidIndexes;
    if (!Array.isArray(solidIndexes) || solidIndexes.length === 0) {
        return { ok: false, message: 'solidIndexes must contain at least one source-solid index.' };
    }
    if (solidIndexes.length > IMPORT_MAX_SOLIDS) {
        return { ok: false, message: `solidIndexes must contain at most ${IMPORT_MAX_SOLIDS} indexes.` };
    }
    for (const index of solidIndexes) {
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) {
            return { ok: false, message: 'Every solid index must be a positive integer.' };
        }
    }
    const sourceUnit = record.sourceUnit;
    if (sourceUnit !== undefined && !isImportSourceUnit(sourceUnit)) {
        return { ok: false, message: "sourceUnit must be 'mm', 'cm', or 'm' when provided." };
    }
    const material = record.material;
    if (material !== undefined && typeof material !== 'string') {
        return { ok: false, message: 'material must be a string when provided.' };
    }
    return {
        ok: true,
        sourcePath: record.sourcePath,
        strategy: record.strategy,
        label: record.label,
        solidIndexes,
        ...(sourceUnit !== undefined ? { sourceUnit } : {}),
        ...(material !== undefined ? { material } : {})
    };
}

function isImportSourceUnit(value: unknown): value is ImportSourceUnit {
    return typeof value === 'string' && (IMPORT_SOURCE_UNITS as readonly string[]).includes(value);
}

/** Re-apply material tags from the previewed drafts to an equivalent plan. */
function withProposalMaterials(planned: readonly ImportBodyDraft[], proposalDrafts: readonly ImportBodyDraft[]): ImportBodyDraft[] {
    return planned.map((draft, index) => {
        const material = proposalDrafts[index]?.material;
        return material !== undefined ? { ...draft, material } : { ...draft };
    });
}

/** One-line summary for the review panel and capability response. */
function importSummary(solidCount: number, bodyCount: number, baseName: string): string {
    const solids = solidCount === 1 ? 'solid' : 'solids';
    const bodies = bodyCount === 1 ? 'body' : 'bodies';
    return `Import ${solidCount} ${solids} from ${baseName} as ${bodyCount} ${bodies}`;
}

/** Single drafting scale when every view shares it, otherwise `AS SHOWN`. */
function drawingSheetScaleLabel(sheet: DrawingSheet): string {
    if (sheet.views.length === 0) {
        return '—';
    }
    const labels = new Set(sheet.views.map((view) => formatDrawingScale(view.scale)));
    return labels.size === 1 ? [...labels][0] : 'AS SHOWN';
}

/** Detached proposal details from a prepared drawing edit. */
function drawingProposalDetails(prepared: PreparedDrawingEdit): NukeCadDrawingProposalDetails {
    return {
        actions: prepared.actions,
        sheet: {
            id: prepared.sheetId,
            name: prepared.sheetName,
            sizeBefore: prepared.sizeBefore,
            sizeAfter: prepared.sizeAfter
        },
        viewChanges: prepared.views.map((view) => ({
            id: view.id,
            kind: view.kind,
            orientation: view.orientation,
            scaleBefore: view.scaleBefore,
            scaleAfter: view.scaleAfter,
            showHiddenBefore: view.showHiddenBefore,
            showHiddenAfter: view.showHiddenAfter
        })),
        dimensionChanges: prepared.dimensions.map((dimension) => ({
            id: dimension.id,
            kind: dimension.kind,
            viewId: dimension.viewId,
            visibleBefore: dimension.visibleBefore,
            visibleAfter: dimension.visibleAfter
        })),
        titleBlockEditable: false,
        requiresDrawingRefresh: true,
        warnings: prepared.warnings
    };
}

/** One short human summary for a prepared drawing edit. */
function summarizeDrawingEdit(prepared: PreparedDrawingEdit): string {
    const parts: string[] = [];
    if (prepared.sizeBefore !== prepared.sizeAfter) {
        parts.push(`Sheet '${prepared.sheetName}' ${prepared.sizeBefore} → ${prepared.sizeAfter}`);
    }
    for (const view of prepared.views) {
        const changes: string[] = [];
        if (view.scaleBefore !== view.scaleAfter) {
            changes.push(`scale ${formatDrawingScale(view.scaleBefore)} → ${formatDrawingScale(view.scaleAfter)}`);
        }
        if (view.showHiddenBefore !== view.showHiddenAfter) {
            changes.push(view.showHiddenAfter ? 'hidden lines on' : 'hidden lines off');
        }
        if (changes.length > 0) {
            parts.push(`${view.kind} ${view.orientation} view: ${changes.join(', ')}`);
        }
    }
    for (const dimension of prepared.dimensions) {
        if (dimension.visibleBefore !== dimension.visibleAfter) {
            parts.push(`${dimension.visibleAfter ? 'Show' : 'Hide'} ${dimension.kind} dimension '${dimension.id}'`);
        }
    }
    return parts.length > 0 ? parts.join('; ') : 'Change drawing sheet settings';
}

/** Whether the candidate is the directory itself or lives below it. */
function isInsideDirectory(directory: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(directory), candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readProposalId(input: unknown): string | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }
    const value = (input as Record<string, unknown>).proposalId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function acknowledgesRegionChanges(input: unknown): boolean {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return false;
    }
    return (input as Record<string, unknown>).acknowledgeRegionChanges === true;
}

function summarize(edits: readonly ResolvedFeatureEdit[]): string {
    return edits.map((edit) => `${edit.featureId} ${edit.param}: ${formatNumber(edit.before)} → ${formatNumber(edit.after)}`).join('; ');
}

/** Read and shape-check one sketch preview request list. */
export function readSketchEditRequests(
    input: unknown
): { ok: true; changes: readonly SketchEditRequest[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: `changes must contain 1 to ${CAD_SKETCH_EDIT_LIMIT} sketch edits.` };
    }
    if (raw.length > CAD_SKETCH_EDIT_LIMIT) {
        return { ok: false, message: `changes must contain at most ${CAD_SKETCH_EDIT_LIMIT} sketch edits.` };
    }
    const changes: SketchEditRequest[] = [];
    for (const [index, entry] of raw.entries()) {
        const label = `Edit ${index + 1}`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: `${label} must be an object.` };
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.sketchId !== 'string' || record.sketchId.length === 0) {
            return { ok: false, message: `${label} needs a non-empty sketchId.` };
        }
        const dimensionId = record.dimensionId;
        const parameterName = record.parameterName;
        if (dimensionId !== undefined && (typeof dimensionId !== 'string' || dimensionId.length === 0)) {
            return { ok: false, message: `${label} dimensionId must be a non-empty string.` };
        }
        if (parameterName !== undefined && (typeof parameterName !== 'string' || parameterName.length === 0)) {
            return { ok: false, message: `${label} parameterName must be a non-empty string.` };
        }
        if ((dimensionId === undefined) === (parameterName === undefined)) {
            return { ok: false, message: `${label} must set exactly one of dimensionId or parameterName.` };
        }
        if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
            return { ok: false, message: `${label} needs a finite numeric value.` };
        }
        if (dimensionId !== undefined) {
            changes.push({ sketchId: record.sketchId, dimensionId: dimensionId as string, value: record.value });
        } else {
            changes.push({ sketchId: record.sketchId, parameterName: parameterName as string, value: record.value });
        }
    }
    return { ok: true, changes };
}

/** Strictly shape-check one topology preview request list. */
export function readTopologyActions(
    input: unknown
): { ok: true; actions: readonly FeatureTopologyAction[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: `changes must contain 1 to ${CAD_TOPOLOGY_EDIT_LIMIT} topology edits.` };
    }
    if (raw.length > CAD_TOPOLOGY_EDIT_LIMIT) {
        return { ok: false, message: `changes must contain at most ${CAD_TOPOLOGY_EDIT_LIMIT} topology edits.` };
    }
    const actions: FeatureTopologyAction[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        const label = `Edit ${index + 1}`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: `${label} must be an object.` };
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.featureId !== 'string' || record.featureId.length === 0) {
            return { ok: false, message: `${label} needs a non-empty featureId.` };
        }
        if (seen.has(record.featureId)) {
            return { ok: false, message: `Duplicate topology edit for feature '${record.featureId}'.` };
        }
        seen.add(record.featureId);
        if (record.action === 'holeDepthMode') {
            const mode = record.mode;
            if (mode !== 'blind' && mode !== 'through') {
                return { ok: false, message: `${label} needs mode 'blind' or 'through'.` };
            }
            if ('count' in record) {
                return { ok: false, message: `${label} cannot set count for a hole depth change.` };
            }
            if (mode === 'through') {
                if ('depth' in record) {
                    return { ok: false, message: `${label} cannot set depth for a through hole.` };
                }
                actions.push({ featureId: record.featureId, action: 'holeDepthMode', mode: 'through' });
                continue;
            }
            if (typeof record.depth !== 'number' || !Number.isFinite(record.depth) || record.depth <= 0) {
                return { ok: false, message: `${label} needs a positive finite depth for a blind hole.` };
            }
            actions.push({ featureId: record.featureId, action: 'holeDepthMode', mode: 'blind', depth: record.depth });
            continue;
        }
        if (record.action === 'patternCount') {
            const count = record.count;
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
                return { ok: false, message: `${label} needs a safe integer count of at least 1.` };
            }
            if (count > CAD_TOPOLOGY_PATTERN_COUNT_LIMIT) {
                return { ok: false, message: `${label} count must be at most ${CAD_TOPOLOGY_PATTERN_COUNT_LIMIT}.` };
            }
            if ('mode' in record || 'depth' in record) {
                return { ok: false, message: `${label} cannot set mode or depth for a pattern count change.` };
            }
            actions.push({ featureId: record.featureId, action: 'patternCount', count });
            continue;
        }
        return { ok: false, message: `${label} has an unknown action '${String(record.action)}'.` };
    }
    return { ok: true, actions };
}

/**
 * Strictly shape-check one assembly preview request list.
 *
 * The pure engine validates semantic rules (grounding, mates, file-backed
 * removal, body existence); this parser rejects malformed or ambiguous action
 * objects before any planning or build starts.
 */
export function readAssemblyActions(
    input: unknown
): { ok: true; actions: readonly AssemblyChangeInput[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: `changes must contain 1 to ${CAD_ASSEMBLY_EDIT_LIMIT} assembly actions.` };
    }
    if (raw.length > CAD_ASSEMBLY_EDIT_LIMIT) {
        return { ok: false, message: `changes must contain at most ${CAD_ASSEMBLY_EDIT_LIMIT} assembly actions.` };
    }
    const actions: AssemblyChangeInput[] = [];
    const claimed = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        const label = `Action ${index + 1}`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: `${label} must be an object.` };
        }
        const record = entry as Record<string, unknown>;
        const action = record.action;
        if (action === 'addInstance') {
            const unexpected = unexpectedKey(record, ['action', 'id', 'part', 'placement', 'scale']);
            if (unexpected !== undefined) {
                return { ok: false, message: `${label} has an unknown field '${unexpected}'.` };
            }
            if (record.id !== undefined && (typeof record.id !== 'string' || record.id.length === 0)) {
                return { ok: false, message: `${label} id must be a non-empty string.` };
            }
            if (typeof record.part !== 'string' || record.part.length === 0) {
                return { ok: false, message: `${label} needs a non-empty part.` };
            }
            if (!isPosQuatPlacement(record.placement)) {
                return { ok: false, message: `${label} needs a placement with a finite position and non-zero quaternion.` };
            }
            if (record.scale !== undefined && !isAssemblyScale(record.scale)) {
                return { ok: false, message: `${label} scale must be a positive number or [sx, sy, sz] array of positives.` };
            }
            if (record.id !== undefined) {
                if (claimed.has(record.id)) {
                    return { ok: false, message: `Duplicate assembly edit for instance '${record.id}'.` };
                }
                claimed.add(record.id);
            }
            actions.push({
                action: 'addInstance',
                ...(record.id !== undefined ? { id: record.id } : {}),
                part: record.part,
                placement: clonePosQuatPlacement(record.placement),
                ...(record.scale !== undefined ? { scale: cloneAssemblyScale(record.scale) } : {})
            });
            continue;
        }
        if (action === 'removeInstance' || action === 'setPlacement') {
            const allowed = action === 'removeInstance' ? ['action', 'instanceId'] : ['action', 'instanceId', 'placement'];
            const unexpected = unexpectedKey(record, allowed);
            if (unexpected !== undefined) {
                return { ok: false, message: `${label} has an unknown field '${unexpected}'.` };
            }
            if (typeof record.instanceId !== 'string' || record.instanceId.length === 0) {
                return { ok: false, message: `${label} needs a non-empty instanceId.` };
            }
            if (claimed.has(record.instanceId)) {
                return { ok: false, message: `Duplicate assembly edit for instance '${record.instanceId}'.` };
            }
            claimed.add(record.instanceId);
            if (action === 'removeInstance') {
                actions.push({ action: 'removeInstance', instanceId: record.instanceId });
                continue;
            }
            if (!isPosQuatPlacement(record.placement)) {
                return {
                    ok: false,
                    message: `${label} needs a placement with a finite position and non-zero quaternion.`
                };
            }
            actions.push({
                action: 'setPlacement',
                instanceId: record.instanceId,
                placement: clonePosQuatPlacement(record.placement)
            });
            continue;
        }
        return { ok: false, message: `${label} has an unknown action '${String(action)}'.` };
    }
    return { ok: true, actions };
}

/**
 * Strictly shape-check one drawing preview request list.
 *
 * The pure planner validates sheet existence, duplicate/no-op targets, mixed
 * sheets, scale bounds, and A3 → A4 fit; this parser rejects malformed action
 * objects and unknown fields before planning starts.
 */
export function readDrawingChangeActions(
    input: unknown
): { ok: true; actions: readonly DrawingChangeAction[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: `changes must contain 1 to ${DRAWING_CHANGE_LIMIT} drawing actions.` };
    }
    if (raw.length > DRAWING_CHANGE_LIMIT) {
        return { ok: false, message: `changes must contain at most ${DRAWING_CHANGE_LIMIT} drawing actions.` };
    }
    const actions: DrawingChangeAction[] = [];
    for (const [index, entry] of raw.entries()) {
        const label = `Action ${index + 1}`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: `${label} must be an object.` };
        }
        const record = entry as Record<string, unknown>;
        const action = record.action;
        if (typeof record.sheetId !== 'string' || record.sheetId.length === 0) {
            return { ok: false, message: `${label} needs a non-empty sheetId.` };
        }
        if (action === 'setSheetSize') {
            const unexpected = unexpectedKey(record, ['action', 'sheetId', 'size']);
            if (unexpected !== undefined) {
                return { ok: false, message: `${label} has an unknown field '${unexpected}'.` };
            }
            if (record.size !== 'A4' && record.size !== 'A3') {
                return { ok: false, message: `${label} sheet size must be 'A4' or 'A3'.` };
            }
            actions.push({ action: 'setSheetSize', sheetId: record.sheetId, size: record.size });
            continue;
        }
        if (action === 'setViewDisplay') {
            const unexpected = unexpectedKey(record, ['action', 'sheetId', 'viewId', 'scale', 'showHidden']);
            if (unexpected !== undefined) {
                return { ok: false, message: `${label} has an unknown field '${unexpected}'.` };
            }
            if (typeof record.viewId !== 'string' || record.viewId.length === 0) {
                return { ok: false, message: `${label} needs a non-empty viewId.` };
            }
            if (record.scale === undefined && record.showHidden === undefined) {
                return { ok: false, message: `${label} needs a scale or showHidden change.` };
            }
            if (record.scale !== undefined && (typeof record.scale !== 'number' || !Number.isFinite(record.scale) || record.scale <= 0)) {
                return { ok: false, message: `${label} scale must be a positive finite number.` };
            }
            if (record.showHidden !== undefined && typeof record.showHidden !== 'boolean') {
                return { ok: false, message: `${label} showHidden must be a boolean.` };
            }
            actions.push({
                action: 'setViewDisplay',
                sheetId: record.sheetId,
                viewId: record.viewId,
                ...(record.scale !== undefined ? { scale: record.scale } : {}),
                ...(record.showHidden !== undefined ? { showHidden: record.showHidden } : {})
            });
            continue;
        }
        if (action === 'setDimensionVisibility') {
            const unexpected = unexpectedKey(record, ['action', 'sheetId', 'dimensionId', 'visible']);
            if (unexpected !== undefined) {
                return { ok: false, message: `${label} has an unknown field '${unexpected}'.` };
            }
            if (typeof record.dimensionId !== 'string' || record.dimensionId.length === 0) {
                return { ok: false, message: `${label} needs a non-empty dimensionId.` };
            }
            if (typeof record.visible !== 'boolean') {
                return { ok: false, message: `${label} visible must be a boolean.` };
            }
            actions.push({
                action: 'setDimensionVisibility',
                sheetId: record.sheetId,
                dimensionId: record.dimensionId,
                visible: record.visible
            });
            continue;
        }
        return { ok: false, message: `${label} has an unknown action '${String(action)}'.` };
    }
    return { ok: true, actions };
}

function unexpectedKey(record: Record<string, unknown>, allowed: readonly string[]): string | undefined {
    return Object.keys(record).find((key) => !allowed.includes(key));
}

function isPosQuatPlacement(value: unknown): value is PosQuatPlacement {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    if (unexpectedKey(record, ['position', 'orientation']) !== undefined) {
        return false;
    }
    if (!isVec3(record.position) || !isQuaternion(record.orientation)) {
        return false;
    }
    const [x, y, z, w] = record.orientation;
    return Math.sqrt(x * x + y * y + z * z + w * w) > 1e-9;
}

function isAssemblyScale(value: unknown): value is number | Vec3 {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0;
    }
    return isVec3(value) && value[0] > 0 && value[1] > 0 && value[2] > 0;
}

function clonePosQuatPlacement(placement: PosQuatPlacement): PosQuatPlacement {
    return {
        position: [placement.position[0], placement.position[1], placement.position[2]],
        orientation: [placement.orientation[0], placement.orientation[1], placement.orientation[2], placement.orientation[3]]
    };
}

function cloneAssemblyScale(scale: number | Vec3): number | Vec3 {
    return Array.isArray(scale) ? [scale[0], scale[1], scale[2]] : scale;
}

/** Group instance BOM rows into quantity rows keyed by the exact part source. */
function assemblyBomQuantities(assembly: AssemblySection): AssemblyBomQuantityRow[] {
    const counts = new Map<string, number>();
    for (const row of buildBomRows(assembly)) {
        counts.set(row.part, (counts.get(row.part) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([part, count]) => ({ part, before: count, after: count, delta: 0 }));
}

/**
 * Label-keyed region coverage for embedded `body:<id>` instances. External
 * parts contribute nothing, because their labels belong to another document.
 */
function assemblyLabelSolidMap(
    selectorMap: Readonly<Record<string, readonly number[]>> | undefined,
    assembly: AssemblySection,
    document: NukeCadDocument
): Record<string, number[]> {
    const bodyById = new Map(document.bodies.map((body) => [body.id, body] as const));
    const labels = new Map<string, Set<number>>();
    for (const instance of assembly.instances) {
        if (!instance.part.startsWith('body:')) {
            continue;
        }
        const bodyId = instance.part.slice('body:'.length);
        const label = bodyById.get(bodyId)?.label;
        if (label === undefined || label.length === 0) {
            continue;
        }
        const solids = selectorMap?.[`${instance.id}/${label}`] ?? [];
        if (!labels.has(label)) {
            labels.set(label, new Set());
        }
        for (const solid of solids) {
            labels.get(label)!.add(solid);
        }
    }
    return Object.fromEntries([...labels.entries()].map(([label, solids]) => [label, [...solids].sort((left, right) => left - right)]));
}

function removedRegionRef(region: AssemblyRemovedRegion): TopologyRegionRef {
    return {
        kind: 'volume',
        selector: region.selector,
        group: region.group,
        ...(region.material !== undefined ? { material: region.material } : {}),
        ...(region.materialId !== undefined ? { materialId: region.materialId } : {}),
        solidIds: region.solidIds
    };
}

function assemblyCollisionWarnings(warnings: readonly string[] | undefined, overlapCheck: boolean): string[] {
    const collisions = (warnings ?? []).filter((warning) => /overlap/i.test(warning));
    if (!overlapCheck) {
        collisions.push('Instance overlap checks are disabled for this document.');
    }
    return uniqueStrings(collisions);
}

function summarizeAssemblyActions(actions: readonly AssemblyChangeInput[]): string {
    const parts = actions.map((action) => {
        if (action.action === 'addInstance') {
            const id = action.id !== undefined ? ` '${action.id}'` : '';
            return `Add${id} ${action.part}`;
        }
        if (action.action === 'removeInstance') {
            return `Remove instance '${action.instanceId}'`;
        }
        return `Move instance '${action.instanceId}'`;
    });
    return parts.join('; ');
}

function uniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values)];
}

/** One short human summary for the review panel and capability response. */
function summarizeSketchEdit(prepared: PreparedSketchEdit): string {
    const edits = prepared.edits;
    if (edits.length > 1) {
        const changes = edits.map((edit) => {
            const target = edit.dimensionId ?? edit.parameterName ?? 'dimension';
            return `${target} ${formatNumber(edit.before)} → ${formatNumber(edit.after)}`;
        });
        return `Change ${edits.length} sketch dimensions in ${prepared.targetSketchName}: ${changes.join('; ')}`;
    }
    if (edits.length === 0) {
        return `Change sketch ${prepared.targetSketchName}`;
    }
    const edit = edits[0];
    const affectedDimensions = edit.affectedDimensionIds.length;
    if (edit.kind === 'parameter' && affectedDimensions > 1) {
        return `${describeSketchEdit(edit)} (${affectedDimensions} dimensions in ${prepared.affectedSketchIds.length} sketches)`;
    }
    return describeSketchEdit(edit);
}

/** One short human summary for a prepared topology edit. */
function summarizeTopologyEdit(document: NukeCadDocument, edits: readonly ResolvedTopologyEdit[]): string {
    const names = new Map(document.features.map((feature) => [feature.id, feature.name] as const));
    return edits
        .map((edit) => {
            const name = names.get(edit.featureId) ?? edit.featureId;
            if (edit.action === 'holeDepthMode') {
                const depth = featureParamNumber(edit.after, 'depth');
                return depth === undefined ? `Open hole ${name} through` : `Change hole ${name} blind depth ${formatNumber(depth)}`;
            }
            const before = featureParamNumber(edit.before, 'count');
            const after = featureParamNumber(edit.after, 'count');
            return `Change pattern ${name} count ${formatCount(before)} → ${formatCount(after)}`;
        })
        .join('; ');
}

function featureParamNumber(params: FeatureParams, key: string): number | undefined {
    const value = (params as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatCount(value: number | undefined): string {
    return value === undefined ? '?' : formatNumber(value);
}

function describeSketchEdit(edit: PreparedSketchEdit['edits'][number]): string {
    const before = formatNumber(edit.before);
    const after = formatNumber(edit.after);
    if (edit.kind === 'parameter') {
        return `Change parameter ${edit.parameterName} ${before} → ${after}`;
    }
    const kind = edit.dimensionKind !== undefined ? ` ${edit.dimensionKind}` : '';
    return `Change sketch ${edit.sketchName}: ${edit.dimensionId}${kind} ${before} → ${after}`;
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function buildSummary(build: GeometryBuildResult): NukeCadProposalBuild {
    return {
        success: build.success,
        solidCount: build.solidCount ?? 0,
        faceCount: build.faceCount ?? 0,
        triangleCount: build.triangleCount ?? 0
    };
}

function buildImpact(before: GeometryBuildResult, after: GeometryBuildResult): NukeCadProposalImpact {
    return {
        solids: { before: before.solidCount ?? 0, after: after.solidCount ?? 0 },
        faces: { before: before.faceCount ?? 0, after: after.faceCount ?? 0 },
        triangles: { before: before.triangleCount ?? 0, after: after.triangleCount ?? 0 },
        boundingBox: { before: before.boundingBox, after: after.boundingBox }
    };
}

/** Validate a topology candidate build without requiring unchanged topology. */
export function validateTopologyCandidateBuild(build: GeometryBuildResult): string | undefined {
    if (!build.success) {
        return build.error || 'The preview build failed.';
    }
    const failed = (build.featureResults ?? []).filter((feature: FeatureResult) => feature.status === 'failed');
    if (failed.length > 0) {
        return `The preview build failed for feature(s): ${failed.map((feature) => feature.featureId).join(', ')}.`;
    }
    if ((build.solidCount ?? 0) <= 0) {
        return 'The preview build produced no solids; the topology change is not a usable geometry change.';
    }
    if ((build.triangleCount ?? 0) <= 0) {
        return 'The preview build produced no tessellation; the topology change is not a usable geometry change.';
    }
    if (!validBoundingBox(build.boundingBox)) {
        return 'The preview build produced an invalid bounding box; the topology change is not a usable geometry change.';
    }
    return undefined;
}

/**
 * Validate an assembly candidate build without requiring unchanged topology.
 *
 * Solid, selector, and region coverage may change (add/remove actions), but the
 * result must be usable, every selector key must belong to a final instance,
 * and every added embedded labelled body must contribute its expected key.
 */
export function validateAssemblyCandidateBuild(
    build: GeometryBuildResult,
    afterSection: AssemblySection,
    document?: NukeCadDocument
): string | undefined {
    if (!build.success) {
        return build.error || 'The preview build failed.';
    }
    const failed = (build.featureResults ?? []).filter((feature: FeatureResult) => feature.status === 'failed');
    if (failed.length > 0) {
        return `The preview build failed for feature(s): ${failed.map((feature) => feature.featureId).join(', ')}.`;
    }
    if ((build.solidCount ?? 0) <= 0) {
        return 'The preview build produced no solids; the assembly change is not a usable geometry change.';
    }
    if ((build.triangleCount ?? 0) <= 0) {
        return 'The preview build produced no tessellation; the assembly change is not a usable geometry change.';
    }
    if (!validBoundingBox(build.boundingBox)) {
        return 'The preview build produced an invalid bounding box; the assembly change is not a usable geometry change.';
    }
    const instanceIds = new Set(afterSection.instances.map((instance) => instance.id));
    for (const key of Object.keys(build.selectorMap ?? {})) {
        const slash = key.indexOf('/');
        const prefix = slash >= 0 ? key.slice(0, slash) : key;
        if (!instanceIds.has(prefix)) {
            return `The preview build produced selector '${key}', which does not belong to a final assembly instance.`;
        }
    }
    if (document !== undefined) {
        const beforeIds = new Set((document.assembly?.instances ?? []).map((instance) => instance.id));
        const bodyById = new Map(document.bodies.map((body) => [body.id, body] as const));
        for (const instance of afterSection.instances) {
            if (beforeIds.has(instance.id) || !instance.part.startsWith('body:')) {
                continue;
            }
            const bodyId = instance.part.slice('body:'.length);
            const label = bodyById.get(bodyId)?.label;
            if (label === undefined || label.length === 0) {
                continue;
            }
            const expected = `${instance.id}/${label}`;
            if (!build.selectorMap || !(expected in build.selectorMap)) {
                return `The preview build did not produce the expected selector '${expected}' for the added instance.`;
            }
        }
    }
    return undefined;
}

/** Region-manifest sidecar path for a `.nuke-cad` document; non-document paths have none. */
function regionSidecarPath(documentPath: string): string | undefined {
    return documentPath.endsWith('.nuke-cad') ? `${documentPath.slice(0, -'.nuke-cad'.length)}.regions.json` : undefined;
}

/** Reject any preview that changes topology or region coverage. */
export function compareBuild(before: GeometryBuildResult, after: GeometryBuildResult): string | undefined {
    const failed = (after.featureResults ?? []).filter((feature: FeatureResult) => feature.status === 'failed');
    if (failed.length > 0) {
        return `The preview build failed for feature(s): ${failed.map((feature) => feature.featureId).join(', ')}.`;
    }
    const beforeSolids = before.solidCount ?? 0;
    const afterSolids = after.solidCount ?? 0;
    if (beforeSolids !== afterSolids) {
        return `The edit changes the solid count (${beforeSolids} → ${afterSolids}); topology changes are not allowed.`;
    }
    if (stableStringify(before.selectorMap ?? null) !== stableStringify(after.selectorMap ?? null)) {
        return 'The edit changes the selector map; region identity must stay unchanged.';
    }
    if (manifestCoverage(before.regionManifest) !== manifestCoverage(after.regionManifest)) {
        return 'The edit changes the region manifest coverage; region identity must stay unchanged.';
    }
    if ((after.triangleCount ?? 0) === 0) {
        return 'The preview build produced no tessellation; the edit is not a usable geometry change.';
    }
    if (!validBoundingBox(after.boundingBox)) {
        return 'The preview build produced an invalid bounding box; the edit is not a usable geometry change.';
    }
    return undefined;
}

function validBoundingBox(box: GeometryBuildResult['boundingBox']): boolean {
    if (!box || !Array.isArray(box.min) || !Array.isArray(box.max) || box.min.length !== 3 || box.max.length !== 3) {
        return false;
    }
    return box.min.every((value, index) => Number.isFinite(value) && Number.isFinite(box.max[index]) && box.max[index] > value);
}

function manifestCoverage(manifest: RegionManifestData | undefined): string {
    if (!manifest) {
        return 'none';
    }
    return stableStringify({
        volumes: manifest.volumes.map((volume) => volume.selector),
        surfaces: manifest.surfaces.map((surface) => surface.selector)
    });
}

/**
 * Compare sketches by their persisted shape. The document store merges
 * sketch-local parameters into `doc.parameters` and clears the field on
 * commit, while solver snapshots still carry the local table.
 */
function persistedSketch(sketch: SketchDef | undefined): SketchDef | undefined {
    return sketch === undefined ? undefined : { ...sketch, parameters: undefined };
}

/** JSON stringify with sorted object keys, so object key order cannot fake a difference. */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'undefined';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
}

function formatIssues(issues: readonly { path: string; message: string }[] | undefined): string[] | undefined {
    return issues && issues.length > 0 ? issues.map((issue) => `${issue.path}: ${issue.message}`) : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
