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
 * Nuke Capability Catalog
 *
 * The static, reviewable description of every capability the AI surfaces
 * advertise: the NukeAI chat prompt and tool list, the read-only Nuke
 * Diagnostics tool list, and the external MCP allowlist. The live registry in
 * `nuke-core` still decides which entries are enabled at runtime; this catalog
 * only decides how each entry is advertised and which boundary may call it.
 *
 * @module nuke-ai/common
 */

/** Domain that owns a cataloged capability. */
export type NukeCapabilityDomain = 'cad' | 'openmc' | 'visualizer';

/** Weakest accurate action risk for a cataloged capability. */
export type NukeCapabilityRisk = 'read' | 'write' | 'execute' | 'destructive';

/** One AI-facing capability and the consumers allowed to advertise it. */
export interface NukeCapabilityCatalogEntry {
    /** Stable dotted registry identifier, for example `nuke.cad.summarizeDocument`. */
    readonly id: string;
    /** Sanitized `nuke_*` name registered by the capability tool bridge. */
    readonly toolName: string;
    /** Short human label rendered in the system prompt. */
    readonly title: string;
    /** One concise line describing inputs, outputs, and side effects. */
    readonly summary: string;
    /** Owning domain extension. */
    readonly domain: NukeCapabilityDomain;
    /** Weakest accurate action risk. */
    readonly risk: NukeCapabilityRisk;
    /** True when NukeAI may advertise and call the tool. */
    readonly chat: boolean;
    /** Explicit external MCP allowlist entry; only `risk: 'read'` may set it. */
    readonly mcpReadOnly?: boolean;
    /** Stable position in the external MCP tool list; required when `mcpReadOnly` is true. */
    readonly mcpOrder?: number;
    /** Available to the read-only Nuke Diagnostics agent; only `risk: 'read'` may set it. */
    readonly diagnostics?: boolean;
}

/**
 * Every capability the AI surfaces know about. Chat entries stay in workflow
 * order; diagnostics-only entries follow them with `chat: false`.
 */
export const NUKE_CAPABILITY_CATALOG: readonly NukeCapabilityCatalogEntry[] = [
    {
        id: 'nuke.cad.summarizeDocument',
        toolName: 'nuke_cad_summarizeDocument',
        title: 'CAD document summary',
        summary:
            'Returns the active path, build success, solid/face/triangle counts, bounding box, warnings, selection, and manifest; pass `{ "includeSolids": true }` only for per-solid detail.',
        domain: 'cad',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 1,
        diagnostics: true
    },
    {
        id: 'nuke.cad.inspectSelection',
        toolName: 'nuke_cad_inspectSelection',
        title: 'CAD selection inspection',
        summary: 'Returns the primary solid, every selected solid, and hidden solid ids; pass no arguments.',
        domain: 'cad',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 2,
        diagnostics: true
    },
    {
        id: 'nuke.cad.diagnoseModel',
        toolName: 'nuke_cad_diagnoseModel',
        title: 'CAD model diagnosis',
        summary: 'Returns read-only build findings for the active document.',
        domain: 'cad',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 3,
        diagnostics: true
    },
    {
        id: 'nuke.cad.previewFeatureChange',
        toolName: 'nuke_cad_previewFeatureChange',
        title: 'CAD feature preview',
        summary:
            'Proposes scalar parameter edits (pad/pocket length, revolve/groove angle, fillet radius, chamfer distance, draft angle, pattern spacing/angle, shell thickness, blind-hole diameter/depth) on a saved document, validates them with a real build, and writes nothing.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.applyFeatureChange',
        toolName: 'nuke_cad_applyFeatureChange',
        title: 'CAD feature apply',
        summary:
            'Applies a previewed feature proposal by id, schedules the rebuild, and returns an undo token; requires explicit confirmation.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.listSketchDimensions',
        toolName: 'nuke_cad_listSketchDimensions',
        title: 'CAD sketch dimension list',
        summary: 'Returns the document path, document parameters, and per-sketch ids, names, datums, consumers, and dimensions.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.previewSketchChange',
        toolName: 'nuke_cad_previewSketchChange',
        title: 'CAD sketch preview',
        summary:
            'Proposes one to eight edits to existing driving dimensions or document parameters referenced by one sketch, runs a real build, returns a proposal id, diff, and impact, and writes nothing.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.applySketchChange',
        toolName: 'nuke_cad_applySketchChange',
        title: 'CAD sketch apply',
        summary:
            'Applies a previewed sketch proposal by id in one atomic commit, rebuilds, and returns an undo token; requires explicit confirmation.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.previewTopologyChange',
        toolName: 'nuke_cad_previewTopologyChange',
        title: 'CAD topology preview',
        summary:
            'Proposes one to eight hole blind/through or pattern-count changes on existing features, runs a real build, and reports solid, face, triangle, added/removed/changed solid, named-region, and saved-OpenMC reference impact.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.applyTopologyChange',
        toolName: 'nuke_cad_applyTopologyChange',
        title: 'CAD topology apply',
        summary:
            'Applies a previewed topology proposal with `{ "proposalId", "acknowledgeRegionChanges": true }`, rebuilds, and returns an undo token; requires explicit confirmation and region acknowledgement.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.inspectImportSource',
        toolName: 'nuke_cad_inspectImportSource',
        title: 'CAD import source inspection',
        summary:
            "The user chooses the STEP/STP, IGES/IGS, or BREP file; a path is only a hint and an arbitrary workspace path opens the native picker unless it is in the document's own `<stem>.parts/` folder. Returns format, size, hash, units, and solids; rejects outside-root, symlink, unsupported-extension, and over-256-MiB sources.",
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.previewImportBodies',
        toolName: 'nuke_cad_previewImportBodies',
        title: 'CAD import body preview',
        summary:
            'Takes `{ sourcePath, strategy: "single" | "perSolid", label, solidIndexes, sourceUnit?, material? }` and creates a plan-only import proposal and CAD Edit Review panel; it never builds geometry, shows a ghost, or mutates the document.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.applyImportBodies',
        toolName: 'nuke_cad_applyImportBodies',
        title: 'CAD import body apply',
        summary:
            'Takes only `{ "proposalId" }`, re-inspects the same source, rejects a stale hash, size, selection, or plan, writes a backup, makes one `addImportBodies` commit, rebuilds, and returns an undo token; requires explicit confirmation.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.summarizeAssembly',
        toolName: 'nuke_cad_summarizeAssembly',
        title: 'CAD assembly summary',
        summary:
            'Returns the active document, grounded instances, part sources, placements, connectors, mates, selector solid ids, BOM quantities, and the overlap policy; use it before any assembly change and never guess an instance, part, or body id.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.previewAssemblyChange',
        toolName: 'nuke_cad_previewAssemblyChange',
        title: 'CAD assembly preview',
        summary:
            'Proposes one to sixteen instance add, remove, or placement actions on an existing grounded assembly, runs a real candidate build, and reports placement rows, BOM count delta, exact overlap warnings, and whether `overlapCheck` is disabled.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.applyAssemblyChange',
        toolName: 'nuke_cad_applyAssemblyChange',
        title: 'CAD assembly apply',
        summary:
            'Takes only `{ "proposalId", "acknowledgeRegionChanges"? }`, re-runs the planner, rejects a stale proposal, writes a backup, commits one store batch, rebuilds, and returns an undo token; requires explicit confirmation and, only when the preview requested it, region acknowledgement.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.summarizeDrawing',
        toolName: 'nuke_cad_summarizeDrawing',
        title: 'CAD drawing summary',
        summary:
            'Returns the document path, drawing version, every sheet with its size and views, and every dimension with its view, visibility, and stale state; the title block is fixed and read-only.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.previewDrawingChange',
        toolName: 'nuke_cad_previewDrawingChange',
        title: 'CAD drawing preview',
        summary:
            'Plans one to sixteen sheet-size, view display, or dimension-visibility actions on one existing sheet and writes nothing; it never builds geometry or shows a ghost.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.applyDrawingChange',
        toolName: 'nuke_cad_applyDrawingChange',
        title: 'CAD drawing apply',
        summary:
            'Takes only `{ "proposalId" }`, applies the stored drawing plan in one `applyDrawingChanges` commit, backs up, refreshes the Drawing Sheet, and returns an undo token; it never schedules a geometry rebuild. Requires explicit confirmation.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.listDocumentTemplates',
        toolName: 'nuke_cad_listDocumentTemplates',
        title: 'CAD document templates',
        summary: 'Lists the shipped document templates read-only and ungated.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.prepareDocumentCreation',
        toolName: 'nuke_cad_prepareDocumentCreation',
        title: 'CAD document creation preview',
        summary:
            'Resolves typed template parameters, re-solves affected sketches, and real-builds a private candidate without installing it.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.createDocumentFromTemplate',
        toolName: 'nuke_cad_createDocumentFromTemplate',
        title: 'CAD document creation',
        summary:
            'Creates a fresh `.nuke-cad` at a workspace path from a prepared template; requires explicit confirmation, is undoable and card-only, and never overwrites an existing file.',
        domain: 'cad',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.cad.inspectScriptSource',
        toolName: 'nuke_cad_inspectScriptSource',
        title: 'CAD script source inspection',
        summary:
            'Returns the active saved `.py` path, bounded text and hash, imports, and whether a top-level `model` is assigned; it asks for confirmation because the script text is sent to the configured model provider.',
        domain: 'cad',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.cad.previewScriptChange',
        toolName: 'nuke_cad_previewScriptChange',
        title: 'CAD script preview',
        summary:
            'Requires the exact `baseScriptHash` and the full `proposedScript`; runs a bubblewrap + libseccomp sandbox build with no network or workspace access, returns a bounded diff and audit id, publishes no ghost, and never writes the source. The chat card has no Apply action.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.applyScriptChange',
        toolName: 'nuke_cad_applyScriptChange',
        title: 'CAD script apply',
        summary:
            'The model must direct the user to the CAD Edit Review panel, which holds the approval nonce, and must never claim it can apply a script from chat.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.cad.exportDagmc',
        toolName: 'nuke_cad_exportDagmc',
        title: 'CAD DAGMC export',
        summary:
            'Rebuilds geometry and writes STEP, DAGMC, cache, and manifest files; summarize the active document first and use this only after an explicit export request.',
        domain: 'cad',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.openmc.summarizeProject',
        toolName: 'nuke_openmc_summarizeProject',
        title: 'OpenMC project summary',
        summary: 'Returns the project path, name, entity counts, and run settings without contacting the backend.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 4,
        diagnostics: true
    },
    {
        id: 'nuke.openmc.summarizeSettings',
        toolName: 'nuke_openmc_summarizeSettings',
        title: 'OpenMC settings summary',
        summary:
            'Returns the run mode and the current value of every NukeAI-editable OpenMC settings path (null when unset); read it before previewing a settings change.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 15,
        diagnostics: true
    },
    {
        id: 'nuke.openmc.previewProjectMetadata',
        toolName: 'nuke_openmc_previewProjectMetadata',
        title: 'OpenMC project metadata preview',
        summary:
            'Validates proposed project name, description, and author edits and returns a `changeSet` diff without writing; preview before every metadata change.',
        domain: 'openmc',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.openmc.summarizeMaterials',
        toolName: 'nuke_openmc_summarizeMaterials',
        title: 'OpenMC material inventory',
        summary:
            'Returns read-only material ids and types; material rows omit the nuclide list. Resolve every id before previewing an edit.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 5
    },
    {
        id: 'nuke.openmc.summarizeTallies',
        toolName: 'nuke_openmc_summarizeTallies',
        title: 'OpenMC tally inventory',
        summary: 'Returns read-only tally ids, names, scores, and filters; resolve every id before previewing an edit.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 6
    },
    {
        id: 'nuke.openmc.summarizeGeometry',
        toolName: 'nuke_openmc_summarizeGeometry',
        title: 'OpenMC geometry inventory',
        summary:
            'Returns read-only CSG surfaces/cells/universes/lattices and DAGMC volumes with material assignments plus geometry issues; resolve every id before previewing an edit.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 7
    },
    {
        id: 'nuke.openmc.validateProject',
        toolName: 'nuke_openmc_validateProject',
        title: 'OpenMC project validation',
        summary: 'Validates geometry, materials, settings, and tallies and reports issues by severity.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 8,
        diagnostics: true
    },
    {
        id: 'nuke.openmc.diagnoseProject',
        toolName: 'nuke_openmc_diagnoseProject',
        title: 'OpenMC project diagnosis',
        summary: 'Adds read-only environment, cross-section, and DAGMC findings to validation.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 10,
        diagnostics: true
    },
    {
        id: 'nuke.openmc.importCad',
        toolName: 'nuke_openmc_importCad',
        title: 'OpenMC CAD import',
        summary:
            'Imports a DAGMC model and region manifest into the active OpenMC project; requires an explicit import request and absolute workspace paths.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.createProject',
        toolName: 'nuke_openmc_createProject',
        title: 'OpenMC project creation',
        summary: 'Creates a project from a template; requires explicit confirmation and must not overwrite.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.applyProjectMetadata',
        toolName: 'nuke_openmc_applyProjectMetadata',
        title: 'OpenMC project metadata apply',
        summary:
            'Applies a previewed project metadata proposal by id; requires explicit confirmation and the id from the preview `changeSet`.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.exportPython',
        toolName: 'nuke_openmc_exportPython',
        title: 'OpenMC Python export',
        summary: 'Writes the model as Python; requires explicit confirmation and must not overwrite.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.previewSettings',
        toolName: 'nuke_openmc_previewSettings',
        title: 'OpenMC settings preview',
        summary:
            'Validates proposed run setting edits and returns a `changeSet` diff without writing; preview before every settings change.',
        domain: 'openmc',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.openmc.applySettings',
        toolName: 'nuke_openmc_applySettings',
        title: 'OpenMC settings apply',
        summary: 'Applies a previewed settings proposal by id; requires an explicit apply request and the id from the preview `changeSet`.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.previewMaterialChange',
        toolName: 'nuke_openmc_previewMaterialChange',
        title: 'OpenMC material preview',
        summary: 'Validates material add/update/remove actions and returns a `changeSet` diff without writing.',
        domain: 'openmc',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.openmc.applyMaterialChange',
        toolName: 'nuke_openmc_applyMaterialChange',
        title: 'OpenMC material apply',
        summary: 'Applies a previewed material proposal by id; requires explicit confirmation and the id from the preview `changeSet`.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.previewTallyChange',
        toolName: 'nuke_openmc_previewTallyChange',
        title: 'OpenMC tally preview',
        summary: 'Validates tally add/update/remove actions and returns a `changeSet` diff without writing.',
        domain: 'openmc',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.openmc.applyTallyChange',
        toolName: 'nuke_openmc_applyTallyChange',
        title: 'OpenMC tally apply',
        summary: 'Applies a previewed tally proposal by id; requires explicit confirmation and the id from the preview `changeSet`.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.previewGeometryChange',
        toolName: 'nuke_openmc_previewGeometryChange',
        title: 'OpenMC geometry preview',
        summary:
            'Validates CSG surface/cell/universe/lattice actions and returns a `changeSet` without writing; summarize first and never guess ids.',
        domain: 'openmc',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.openmc.applyGeometryChange',
        toolName: 'nuke_openmc_applyGeometryChange',
        title: 'OpenMC geometry apply',
        summary: 'Applies a previewed CSG proposal by id; requires explicit confirmation.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.previewDagmcChange',
        toolName: 'nuke_openmc_previewDagmcChange',
        title: 'OpenMC DAGMC preview',
        summary:
            'Validates DAGMC volume-material assignments and returns a `changeSet` without writing; summarize first and never guess ids.',
        domain: 'openmc',
        risk: 'read',
        chat: true
    },
    {
        id: 'nuke.openmc.applyDagmcChange',
        toolName: 'nuke_openmc_applyDagmcChange',
        title: 'OpenMC DAGMC apply',
        summary: 'Applies a previewed DAGMC proposal by id; requires explicit confirmation.',
        domain: 'openmc',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.openmc.runSimulation',
        toolName: 'nuke_openmc_runSimulation',
        title: 'OpenMC simulation run',
        summary:
            'Validates the project and starts an OpenMC run; requires an explicit run request and a valid environment, and never starts while validation reports errors.',
        domain: 'openmc',
        risk: 'execute',
        chat: true
    },
    {
        id: 'nuke.openmc.getRunStatus',
        toolName: 'nuke_openmc_getRunStatus',
        title: 'OpenMC run status',
        summary:
            'Reports whether a run is active and returns the log tail; never start, cancel, or restart a run while answering a status question.',
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 9,
        diagnostics: true
    },
    {
        id: 'nuke.openmc.diagnoseRun',
        toolName: 'nuke_openmc_diagnoseRun',
        title: 'OpenMC run diagnosis',
        summary: "Triages the active run's log tail into read-only findings.",
        domain: 'openmc',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 11,
        diagnostics: true
    },
    {
        id: 'nuke.viz.summarizeStatepoint',
        toolName: 'nuke_viz_summarizeStatepoint',
        title: 'Statepoint summary',
        summary: 'Returns batches, k-effective when present, and the tallies with their scores, nuclides, and mesh status.',
        domain: 'visualizer',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 12,
        diagnostics: true
    },
    {
        id: 'nuke.viz.diagnoseStatepoint',
        toolName: 'nuke_viz_diagnoseStatepoint',
        title: 'Statepoint diagnosis',
        summary: 'Triages loaded statepoint metadata (k-effective uncertainty, batches, tally coverage) without reading raw tally values.',
        domain: 'visualizer',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 13,
        diagnostics: true
    },
    {
        id: 'nuke.viz.openStatepoint',
        toolName: 'nuke_viz_openStatepoint',
        title: 'Statepoint viewer',
        summary: 'Opens or activates a statepoint viewer; requires an explicit open request and an absolute workspace path.',
        domain: 'visualizer',
        risk: 'write',
        chat: true
    },
    {
        id: 'nuke.viz.captureView',
        toolName: 'nuke_viz_captureView',
        title: 'DAGMC viewport capture',
        summary:
            'Captures the active DAGMC viewer as a truthful image preview; describe what the preview shows and state its limitations, and do not claim the view represents data that was not captured.',
        domain: 'visualizer',
        risk: 'read',
        chat: true,
        mcpReadOnly: true,
        mcpOrder: 14
    },
    {
        id: 'nuke.viz.compareStatepoints',
        toolName: 'nuke_viz_compareStatepoints',
        title: 'Statepoint comparison',
        summary:
            'Compares two absolute workspace statepoints by metadata (batches, generations, k-effective with uncertainty, tally ids) without loading either into the viewer.',
        domain: 'visualizer',
        risk: 'read',
        chat: false,
        diagnostics: true
    },
    {
        id: 'nuke.viz.analyzeTallySeries',
        toolName: 'nuke_viz_analyzeTallySeries',
        title: 'Tally series analysis',
        summary:
            'Aggregates one tally and score across one to fifty absolute workspace statepoints and reports per-step values, standard deviations, bin counts, and uncertainty findings; aggregate steps only.',
        domain: 'visualizer',
        risk: 'read',
        chat: false,
        diagnostics: true
    }
] satisfies readonly NukeCapabilityCatalogEntry[];

/** All entries NukeAI may advertise, in workflow order. */
export const NUKE_CAPABILITY_TOOL_NAMES: readonly string[] = NUKE_CAPABILITY_CATALOG.filter((entry) => entry.chat).map(
    (entry) => entry.toolName
);

/** Stable dotted ids for the NukeAI tool list, in the same order as the tool names. */
export const NUKE_CAPABILITY_IDS: readonly string[] = NUKE_CAPABILITY_CATALOG.filter((entry) => entry.chat).map((entry) => entry.id);

/** Read-only capabilities explicitly available to the Nuke Diagnostics agent. */
export const NUKE_DIAGNOSTICS_CAPABILITY_IDS: readonly string[] = NUKE_CAPABILITY_CATALOG.filter((entry) => entry.diagnostics === true).map(
    (entry) => entry.id
);

/** Sanitized tool names for the Nuke Diagnostics agent, in catalog order. */
export const NUKE_DIAGNOSTICS_TOOL_NAMES: readonly string[] = NUKE_CAPABILITY_CATALOG.filter((entry) => entry.diagnostics === true).map(
    (entry) => entry.toolName
);

/** External MCP allowlist; only explicit `read` entries can cross the endpoint. */
export const MCP_READ_ONLY_CAPABILITY_IDS: readonly string[] = NUKE_CAPABILITY_CATALOG.filter(
    (entry) => entry.mcpReadOnly === true && entry.risk === 'read'
)
    .sort((left, right) => (left.mcpOrder ?? Number.MAX_SAFE_INTEGER) - (right.mcpOrder ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => entry.id);

/** Entries grouped by action risk, preserving catalog order inside each group. */
export type NukeCapabilitiesByRisk = Record<NukeCapabilityRisk, readonly NukeCapabilityCatalogEntry[]>;

/** Group catalog entries by risk; diagnostics-only entries are included when present. */
export function groupNukeCapabilitiesByRisk(
    entries: readonly NukeCapabilityCatalogEntry[] = NUKE_CAPABILITY_CATALOG
): NukeCapabilitiesByRisk {
    const groups: Record<NukeCapabilityRisk, NukeCapabilityCatalogEntry[]> = {
        read: [],
        write: [],
        execute: [],
        destructive: []
    };
    for (const entry of entries) {
        groups[entry.risk].push(entry);
    }
    return groups;
}

/**
 * Validate catalog invariants that the derived lists rely on. Returns one
 * message per violation so tests can report every drift at once.
 */
export function validateNukeCapabilityCatalog(entries: readonly NukeCapabilityCatalogEntry[]): string[] {
    const errors: string[] = [];
    const ids = new Set<string>();
    const toolNames = new Set<string>();
    for (const entry of entries) {
        if (ids.has(entry.id)) {
            errors.push(`Duplicate capability id ${entry.id}.`);
        }
        ids.add(entry.id);
        if (toolNames.has(entry.toolName)) {
            errors.push(`Duplicate tool name ${entry.toolName}.`);
        }
        toolNames.add(entry.toolName);
        const expectedToolName = toNukeCapabilityToolName(entry.id);
        if (entry.toolName !== expectedToolName) {
            errors.push(`Tool name ${entry.toolName} must be the sanitized form of ${entry.id} (${expectedToolName}).`);
        }
        if (entry.mcpReadOnly === true && entry.risk !== 'read') {
            errors.push(`MCP allowlist entry ${entry.id} must be risk read, not ${entry.risk}.`);
        }
        if (entry.mcpReadOnly === true && entry.mcpOrder === undefined) {
            errors.push(`MCP allowlist entry ${entry.id} must declare an mcpOrder.`);
        }
        if (entry.mcpReadOnly !== true && entry.mcpOrder !== undefined) {
            errors.push(`Capability ${entry.id} declares mcpOrder without mcpReadOnly.`);
        }
        if (entry.diagnostics === true && entry.risk !== 'read') {
            errors.push(`Diagnostics entry ${entry.id} must be risk read, not ${entry.risk}.`);
        }
        if (entry.diagnostics === true && !entry.chat && entry.mcpReadOnly === true) {
            errors.push(`Diagnostics-only entry ${entry.id} must not be MCP allowlisted.`);
        }
    }
    return errors;
}

/** Convert a capability id to the provider-safe tool name registered by the bridge. */
export function toNukeCapabilityToolName(capabilityId: string): string {
    return capabilityId
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 128)
        .replace(/_+$/g, '');
}
