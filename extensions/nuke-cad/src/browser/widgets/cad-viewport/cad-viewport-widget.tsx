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

/**
 * CAD viewport widget.
 *
 * Renders the tessellated B-rep using three.js. Face/solid picking updates the
 * shared selection state; selecting a manifest row will highlight the matching
 * geometry. The scene is rebuilt only when the tessellation changes and is
 * rendered on demand (orbit, selection, resize, theme change), never in a
 * perpetual animation loop.
 *
 * Sketch mode is integrated as an overlay on top of the viewport. Entering
 * sketch mode switches to an orthographic camera on the selected datum plane,
 * hides the 3D model, and routes pointer events to the sketch controller.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message, WidgetManager } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { Disposable } from '@theia/core/lib/common/disposable';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { URI } from '@theia/core/lib/common/uri';
import { MonacoWorkspace } from '@theia/monaco/lib/browser/monaco-workspace';
import { MonacoEditorModel } from '@theia/monaco/lib/browser/monaco-editor-model';
import * as THREE from 'three';

import { NukeCadBackendService, GeometryBuildResult } from '../../../common/nuke-cad-protocol';
import { NukeCadStateManager, CadModel, CadSelection } from '../../state/nuke-cad-state-manager';
import { buildSolidSummaries } from '../outline-panel/solid-summaries';
import { addSolidsToSelection, selectionSolidIds, toggleSolidSelection } from '../outline-panel/outline-interactions';
import { NukeCadCommands } from '../../commands';
import { LoadingAnimations } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { NukeEmptyState, NukeLoadingOverlay } from 'nuke-essentials/lib/theme/browser/components';
import { ViewBadge, ViewerNavBar, ViewCube } from 'nuke-essentials/lib/theme/browser/components';
import type { ViewCubeHandle, ViewerNavAction } from 'nuke-essentials/lib/theme/browser/components';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import { SketchModeController } from '../../sketch/sketch-mode-controller';
import { SKETCH_TOOL_SHORTCUTS } from '../../sketch/sketch-session';
import {
    defaultSketchViewSize,
    intersectRayPlane,
    pixelRadiusToModelUnits,
    sketchToWorld,
    worldToSketch,
    type DatumKind
} from '../../sketch/sketch-math';
import { createSnapConfig, snap } from '../../sketch/snap';
import { ensureNukeCadExtension } from './cad-save-path';
import { CadSketchOverlay, DocumentTemplatePicker, type DatumDraft } from './cad-sketch-overlay';
import { CadDocumentStore, createSketchId, computeDependsOn, getAssemblySection, uniqueFeatureId } from '../../document/cad-document-store';
import type { DocumentMutationResult } from '../../document/cad-document-store';
import {
    MemoryResultCache,
    PartialRebuildTracker,
    RESULT_CACHE_BUILDER_VERSION,
    RESULT_CACHE_OCP_UNKNOWN,
    allFeatureIds,
    cacheKeyForDocument,
    checkOpenFastPath,
    computeResultCacheKeys,
    featuresConsumingSketch,
    partialCacheDirForDocument,
    planDirtyRebuild,
    shouldUsePartialPlan
} from '../../document/cad-document-store';
import { NukeCadPreferences } from '../../nuke-cad-preferences';
import { CAD_COMMAND_IDS } from '../../cad-command-registry';
import { PreferenceScope, PreferenceService } from '@theia/core/lib/common/preferences';
import { QuickInputService } from '@theia/core/lib/browser/quick-input';
import { DOCUMENT_TEMPLATES } from '../../../common/document-templates';
import {
    type SketchDef,
    type FeatureDef,
    type FeatureType,
    type FeatureParams,
    type CurvePoint,
    type NukeCadDocument,
    type BodyAppearance
} from '../../../common/cad-document';
import { type TopologyRef } from '../../../common/topology-refs';
import {
    FaceHighlighter,
    type FacePickCandidate,
    type FacePickHit,
    buildTopologyRef,
    pointerToNdc,
    projectHitToFaceUv,
    raycastFace,
    raycastFaceCandidates
} from './face-picker';
import { cadViewportColors, resolveViewportBackground, type ViewportBackgroundStyle } from './viewport-colors';
import { applyNavigationStyle, type NavigationStyle } from './navigation-styles';
import {
    EdgeHighlighter,
    type EdgePickHit,
    buildEdgeLine,
    buildEdgeTopologyRef,
    raycastEdge,
    cancelDrawingDimensionPick,
    drawingDimensionTargetsNeeded,
    getDrawingDimensionPickRequest,
    onDrawingDimensionPickRequest,
    publishDrawingDimensionEdgeHit,
    type DrawingDimensionPickRequest
} from './edge-picker';
import { type DressUpPickMode, dressUpPickRequest } from './dress-up-pick';
import { expandTangentEdgeChain } from './tangent-edge-chain';
import {
    DEFAULT_GHOST_OPACITY,
    GHOST_OPACITY_MAX,
    GHOST_OPACITY_MIN,
    GHOST_OPACITY_STEP,
    SHADING_MODES,
    clampGhostOpacity,
    meshShadingFlags,
    type ShadingMode
} from './shading-modes';
import {
    DEFAULT_SECTION_FRACTION,
    SECTION_AXES,
    clampSectionFraction,
    sectionPlaneFromBox,
    sectionStatusLabel,
    type SectionAxis,
    type SectionState
} from './section-plane';
import {
    MEASURE_CLEAR_NOTE,
    createMeasureAngle,
    createMeasureRadius,
    createMeasureSegment,
    formatMeasureAngle,
    formatMeasureDistance,
    formatMeasureRadius,
    formatMeasurementValue,
    isMeasureAngle,
    isMeasureRadius,
    isMeasureSegment,
    layoutMeasureLabels,
    clampMeasureLabel,
    measureAngle,
    measureDistance,
    nextMeasureId,
    projectMeasurePoint,
    restoreSavedMeasurements,
    toSavedMeasurement,
    type Measurement,
    type MeasurementDecimals,
    type MeasureAngle,
    type MeasureKind,
    type MeasureLabelCandidate,
    type MeasurePoint3D,
    type MeasureRadius,
    type MeasureSegment,
    type MeasureToolMode,
    type MeasureViewState
} from './measure-tool';
import { edgeRadius } from './radius-fit';
import { clampExplodeFactor, planExplodeOffsets, type ExplodeSolidCentroid } from './explode-view';
import { visibleCurveIds, type CurvePathUser } from './curve-visibility';
import { computeClipPlanes } from './clip-planes';
import { headerRegionTarget, useDraggablePanel } from './draggable-panel';
import { buildFeaturePreviewDocument, resolveCurvePick, type FeaturePreviewRequest } from './sweep-pipe';
import {
    assemblyConnectorTriads,
    connectorFrameInAssembly,
    instanceSolidIds,
    resolveConnectorPick,
    solveAssemblyTransforms,
    type ConnectorTriad
} from './assembly-view';
import { MateDialog, type MateDraft } from './mate-dialog';
import { BodyAppearanceDialog, type BodyAppearanceTarget } from './body-appearance-dialog';
import {
    BODY_APPEARANCE_DEFAULT_COLOR,
    BODY_APPEARANCE_DEFAULT_OPACITY,
    normalizeAppearancePresets,
    resolveBodyDisplayAppearance,
    type AppearancePreset
} from './body-appearance';
import { AssemblyInstanceList } from './assembly-instance-list';
import { faceReuseKey, planFaceReuse, type ParsedTessCurve, type ParsedTessData } from './tess-reuse';
import { parseTessellationAsync } from './tess-parse-client';
import { attributeBodyToFeature, buildViewportContextMenu, openContextMenu, openViewportContextMenu } from './viewport-context-menu';
import { buildSketchContextMenu, type SketchContextMenuAction, type SketchContextTarget } from './sketch-context-menu';
import { buildSelectOtherRows, openSelectOtherMenu } from './select-other-menu';
import './cad-viewport.css';
import './cad-icons.css';

/** Tessellation payload in its transfer-friendly parsed form (typed arrays). */
type TessData = ParsedTessData;

/** Camera pose captured by a saved named view (world-space `[x, y, z]` tuples). */
export interface CadCameraState {
    readonly position: CurvePoint;
    readonly target: CurvePoint;
    readonly up: CurvePoint;
}

/** Imperative camera access the mounted scene hands back to the widget. */
export interface CadCameraApi {
    readonly getCameraState: () => CadCameraState;
    readonly setCameraState: (state: CadCameraState) => void;
}

function isFiniteCameraVector(value: unknown): value is CurvePoint {
    return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Lightweight stage timings behind a localStorage flag: set
 * `localStorage['nuke-cad-profile'] = '1'` to log file-read/parse/buildModel
 * splits for the tessellation load path. Off by default — no committed noise.
 */
const PROFILE_TESSELLATION_LOAD = typeof localStorage !== 'undefined' && localStorage.getItem('nuke-cad-profile') === '1';

@injectable()
export class CadViewportWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-viewport-widget';
    static readonly LABEL = 'CAD Viewport';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(NukeCadStateManager)
    protected readonly stateManager: NukeCadStateManager;

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(NukeCadBackendService)
    protected readonly backendService: NukeCadBackendService;

    @inject(CadDocumentStore)
    protected readonly documentStore: CadDocumentStore;

    @inject(MonacoWorkspace)
    protected readonly monacoWorkspace: MonacoWorkspace;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(NukeCadPreferences)
    protected readonly preferences: NukeCadPreferences;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    private tessData?: TessData;
    private loading = false;
    private loadingMessage = 'Loading CAD model...';
    private buildError?: string;
    /** Non-fatal warnings from the last build (e.g. cross-body overlap). */
    private buildWarnings: string[] = [];
    /** Monotonically increasing token; stale tessellation loads are dropped. */
    private tessLoadToken = 0;
    /** True between starting a tessellation load and its token-guarded completion. */
    private tessLoadInFlight = false;
    /** Path of the tessellation currently rendered; used to skip redundant reloads. */
    private loadedTessPath?: string;
    private saveRebuildTimer?: ReturnType<typeof setTimeout>;
    /** In-flight rebuild promise; new edits queue exactly one follow-up rebuild. */
    private rebuildPromise?: Promise<void>;
    /** True when an edit arrived while a rebuild was in-flight. */
    private rebuildPending = false;
    /**
     * True when document edits arrived while manual-rebuild mode skipped the
     * automatic rebuild. Cleared on a successful rebuild and on fresh
     * document open; never set in auto mode.
     */
    private buildStale = false;
    /** In-session result cache (memory-backed; untitled docs never touch the zip). */
    private readonly resultCache = new MemoryResultCache();
    /** Edit → plan → partial-RPC lifecycle tracker (progress/cancel/error states). */
    private readonly rebuildTracker = new PartialRebuildTracker();
    /** Monotonically increasing token; superseded/cancelled rebuilds drop their results. */
    private rebuildToken = 0;
    /** Job id of the in-flight partial rebuild, for cancellation. */
    private pendingPartialJobId?: string;
    private partialJobCounter = 0;
    /** One fallback warning per viewport instance, not per rebuild. */
    private partialFallbackWarned = false;

    /** True while the datum picker is waiting for the user to choose a plane. */
    sketchSetupVisible = false;
    /** True while the sketch solver is loading (Start Sketch clicked, session not active yet). */
    sketchEntering = false;
    /** True while a feature creation dialog is open. */
    featureCreationType?: FeatureType;
    /** Body preselected as the dialog target, resolved from the viewport selection on open. */
    featureCreationBodyId?: string;
    /** Id of the feature being edited, when the dialog is in edit mode. */
    editingFeatureId?: string;
    private sketchController?: SketchModeController;
    private sketchCamera?: THREE.PerspectiveCamera;
    /** Camera get/set pair published by the mounted scene (named views). */
    private cameraApi?: CadCameraApi;
    /** Id of the sketch being edited, or undefined for a new sketch. */
    private editingSketchId?: string;
    /** Active face-pick mode, if any. */
    private facePickMode?: 'sketchDatum' | 'externalGeometry';
    /** Offset to apply when creating a face datum. */
    private facePickOffset = 0;
    /** Feature id used for external-geometry references (the producing feature). */
    private facePickFeatureId?: string;
    /** Active dress-up pick mode and the callback that receives the next pick. */
    private dressUpPickMode?: DressUpPickMode;
    private dressUpPickCallback?: (ref: TopologyRef) => void;
    /** Active hole face-pick mode and the callback that receives the picked face. */
    private holePickMode?: { callback: (ref: TopologyRef, uv: [number, number]) => void };
    /** Active curve-pick mode and the callback that receives the picked curve id. */
    private curvePickMode?: { callback: (curveId: string) => void };
    /**
     * Active drawing-dimension edge-pick mode, driven by the Drawing Sheet
     * widget through the `edge-picker` broker (not by a local dialog):
     * `kind` selects the banner text and target count, `picked` feeds the
     * banner progress. The mode stays active across picks (distance needs
     * two) until the sheet commits the dimension or either side cancels.
     */
    private drawingDimensionPickMode?: { kind: DrawingDimensionPickRequest['kind']; picked: number };
    /**
     * Active connector-pick mode for the mate dialog: which side (A/B) the
     * next viewport click feeds. Mirrors the dress-up pick pattern (banner +
     * Cancel, hover triad highlight, right-click/Escape cancel, guarded by
     * `resolveConnectorPick` against deleted instances).
     */
    private connectorPickMode?: { side: 'A' | 'B' };
    /** Connector ids picked in the viewport for the open mate dialog. */
    private mateConnectorA?: string;
    private mateConnectorB?: string;
    /** True while the mate creation dialog is open. */
    private mateDialogOpen = false;
    /** Ghosted mate preview (both connectors at solved poses in `cad-preview`). */
    private matePreviewEnabled = false;
    /** Tessellation of the pending sweep/pipe draft (ghosted preview), if any. */
    private previewTessData?: TessData;
    /** Monotonically increasing token; stale preview builds are dropped. */
    private featurePreviewToken = 0;
    /** True while the viewport section plane is engaged. */
    private sectionActive = false;
    /** Body targeted by the Appearance dialog (display-only color/opacity override). */
    private appearanceTarget?: BodyAppearanceTarget;
    /** Distinct body ids owning the viewport selection when the Appearance dialog opened. */
    private appearanceSelectionBodyIds: readonly string[] = [];

    /** Toggle viewport section mode (nav-cluster button). */
    protected readonly handleSetSectionActive = (active: boolean): void => {
        this.sectionActive = active;
        this.update();
    };

    /** Escape inside the viewport exited section mode; sync the chrome. */
    protected readonly handleExitSection = (): void => {
        this.sectionActive = false;
        this.update();
    };

    /** Context-menu entry: hide one solid (viewport state, never document state). */
    protected readonly handleHideSolid = (solidId: number): void => {
        if (this.stateManager.isSolidHidden(solidId)) {
            return;
        }
        this.stateManager.setHiddenSolidIds([...this.stateManager.hiddenSolidIds, solidId]);
    };

    /**
     * Context-menu entry: isolate the body owning the solid (falling back to
     * the solid alone when the build produced no body id, e.g. script/STEP).
     */
    protected readonly handleIsolateSolid = (solidId: number): void => {
        const solids = this.tessData?.solids ?? [];
        const bodyId = solids.find((solid) => solid.solidId === solidId)?.bodyId;
        const keep =
            bodyId === undefined
                ? new Set([solidId])
                : new Set(solids.filter((solid) => solid.bodyId === bodyId).map((solid) => solid.solidId));
        this.stateManager.setHiddenSolidIds(solids.map((solid) => solid.solidId).filter((id) => !keep.has(id)));
    };

    /** Context-menu entry: reveal every hidden solid. */
    protected readonly handleShowAllSolids = (): void => {
        this.stateManager.setHiddenSolidIds([]);
    };

    /** Context-menu entry: hide every solid in a multi-selection (viewport state, never document state). */
    protected readonly handleHideSolids = (solidIds: readonly number[]): void => {
        const hidden = new Set(this.stateManager.hiddenSolidIds);
        for (const solidId of solidIds) {
            hidden.add(solidId);
        }
        this.stateManager.setHiddenSolidIds([...hidden]);
    };

    /**
     * Context-menu entry: isolate the bodies owning a multi-selection (same
     * body-grouping as single isolate, unioned over the set).
     */
    protected readonly handleIsolateSolids = (solidIds: readonly number[]): void => {
        const solids = this.tessData?.solids ?? [];
        const keep = new Set<number>();
        for (const solidId of solidIds) {
            const bodyId = solids.find((solid) => solid.solidId === solidId)?.bodyId;
            if (bodyId === undefined) {
                keep.add(solidId);
            } else {
                for (const solid of solids) {
                    if (solid.bodyId === bodyId) {
                        keep.add(solid.solidId);
                    }
                }
            }
        }
        this.stateManager.setHiddenSolidIds(solids.map((solid) => solid.solidId).filter((id) => !keep.has(id)));
    };

    /**
     * Stable callbacks handed to the React component so the three.js scene is
     * only rebuilt when the tessellation itself changes.
     */
    protected readonly handleViewportSelect = (selection: CadSelection): void => {
        this.stateManager.setSelection(selection);
    };

    protected readonly subscribeSelection = (listener: (selection: CadSelection) => void): Disposable => {
        listener(this.stateManager.selection);
        return this.stateManager.onSelectionChange(listener);
    };

    /**
     * Context-menu/Escape Clear Selection: reset both sides of the selection.
     * The document store owns the tree selection (feature/body/sketch/curve);
     * the state manager owns the viewport solids and their highlight. Clearing
     * only one leaves the other visibly active.
     */
    protected readonly handleClearSelection = (): void => {
        this.documentStore.clearSelection();
        this.stateManager.setSelection({});
    };

    /** Context-menu Find in Feature Tree: select the feature, then reveal its panel. */
    protected readonly handleRevealFeature = (featureId: string): void => {
        this.documentStore.selectFeature(featureId);
        void this.commandService.executeCommand(NukeCadCommands.OPEN_FEATURE_TREE.id);
    };

    /**
     * Distinct body ids owning the current viewport selection, in selection
     * order. Solids without a body mapping (script/STEP models) and stale
     * body ids are skipped; the result drives the dialog's
     * "Apply to all selected bodies" action.
     */
    protected selectedBodyIdsForAppearance(): readonly string[] {
        const document = this.documentStore.document;
        if (document === undefined) {
            return [];
        }
        const knownBodies = new Set(document.bodies.map((body) => body.id));
        const bodyIds = new Set<string>();
        for (const solidId of selectionSolidIds(this.stateManager.selection)) {
            const bodyId = this.stateManager.solidSummaries.find((summary) => summary.solidId === solidId)?.bodyId;
            if (bodyId !== undefined && knownBodies.has(bodyId)) {
                bodyIds.add(bodyId);
            }
        }
        return Array.from(bodyIds);
    }

    /** Normalized user appearance presets from the preference store. */
    protected appearancePresets(): readonly AppearancePreset[] {
        return normalizeAppearancePresets(this.preferences['nukeCad.appearancePresets']);
    }

    /** Context-menu Appearance…: open the per-body color/opacity dialog. */
    protected readonly handleOpenAppearance = (bodyId: string): void => {
        const body = this.documentStore.document?.bodies.find((b) => b.id === bodyId);
        if (body === undefined) {
            return;
        }
        const label = body.label !== undefined && body.label.length > 0 ? `${body.name} · ${body.label}` : body.name;
        this.appearanceTarget = { bodyId, label };
        this.appearanceSelectionBodyIds = this.selectedBodyIdsForAppearance();
        this.update();
    };

    protected readonly handleCloseAppearance = (): void => {
        this.appearanceTarget = undefined;
        this.appearanceSelectionBodyIds = [];
        this.update();
    };

    /**
     * Appearance dialog OK: commit through the store (validation, undo, dirty
     * flag) and close on success. A failed commit keeps the dialog open so the
     * user can correct the values; the store never schedules a rebuild.
     */
    protected readonly handleApplyAppearance = (bodyId: string, appearance: BodyAppearance): void => {
        const result = this.documentStore.setBodyAppearance(bodyId, appearance);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to set the body appearance.');
            return;
        }
        this.appearanceTarget = undefined;
        this.appearanceSelectionBodyIds = [];
        this.update();
    };

    /** Appearance dialog OK with "Apply to all selected bodies": one store commit. */
    protected readonly handleApplyAppearanceToBodies = (bodyIds: readonly string[], appearance: BodyAppearance): void => {
        const result = this.documentStore.setBodiesAppearance(bodyIds, appearance);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to set the body appearance.');
            return;
        }
        this.appearanceTarget = undefined;
        this.appearanceSelectionBodyIds = [];
        this.update();
    };

    protected readonly handleRemoveAppearance = (bodyId: string): void => {
        const result = this.documentStore.setBodyAppearance(bodyId, undefined);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to remove the body appearance.');
            return;
        }
        this.appearanceTarget = undefined;
        this.appearanceSelectionBodyIds = [];
        this.update();
    };

    /** Remove override with "Apply to all selected bodies": one store commit. */
    protected readonly handleRemoveAppearanceFromBodies = (bodyIds: readonly string[]): void => {
        const result = this.documentStore.setBodiesAppearance(bodyIds, undefined);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to remove the body appearance.');
            return;
        }
        this.appearanceTarget = undefined;
        this.appearanceSelectionBodyIds = [];
        this.update();
    };

    /**
     * "Save preset…": prompt for a name and write the draft appearance to the
     * user-scoped preset library. Same trimmed name replaces the existing
     * entry; the resolved name feeds the dialog's preset selection.
     */
    protected readonly handleSaveAppearancePreset = async (appearance: BodyAppearance): Promise<string | undefined> => {
        const name = await this.quickInput.input({
            title: 'Save Appearance Preset',
            prompt: 'Name this appearance preset',
            placeHolder: 'Preset name'
        });
        if (name === undefined) {
            return undefined;
        }
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            return undefined;
        }
        const presets = this.appearancePresets().filter((preset) => preset.name !== trimmed);
        const next = normalizeAppearancePresets([
            ...presets,
            {
                name: trimmed,
                color: appearance.color ?? BODY_APPEARANCE_DEFAULT_COLOR,
                opacity: appearance.opacity ?? BODY_APPEARANCE_DEFAULT_OPACITY
            }
        ]);
        try {
            await this.preferenceService.set('nukeCad.appearancePresets', next, PreferenceScope.User);
        } catch (error) {
            this.messageService.error(`Failed to save the appearance preset: ${error}`);
            return undefined;
        }
        return trimmed;
    };

    /** Delete one user appearance preset by name. */
    protected readonly handleDeleteAppearancePreset = async (name: string): Promise<void> => {
        const next = this.appearancePresets().filter((preset) => preset.name !== name);
        try {
            await this.preferenceService.set('nukeCad.appearancePresets', next, PreferenceScope.User);
        } catch (error) {
            this.messageService.error(`Failed to delete the appearance preset: ${error}`);
        }
    };

    protected readonly subscribeHiddenSolids = (listener: (ids: readonly number[]) => void): Disposable => {
        listener(this.stateManager.hiddenSolidIds);
        return this.stateManager.onHiddenSolidsChange(listener);
    };

    protected readonly subscribeThemeChange = (listener: () => void): Disposable => this.themeService.onDidColorThemeChange(listener);

    protected readonly dismissBuildError = (): void => {
        this.buildError = undefined;
        this.update();
    };

    protected readonly dismissBuildWarnings = (): void => {
        this.buildWarnings = [];
        this.update();
    };

    protected readonly handleControllerReady = (controller: SketchModeController, camera: THREE.PerspectiveCamera): void => {
        this.sketchController = controller;
        this.sketchCamera = camera;
    };

    /**
     * Camera access for named views: the mounted scene publishes its
     * get/set camera-state pair and clears it on unmount.
     */
    protected readonly handleCameraApiReady = (api: CadCameraApi | undefined): void => {
        this.cameraApi = api;
    };

    protected readonly handleEnterSketch = (kind: DatumKind, offset: number): void => {
        this.sketchSetupVisible = false;
        this.sketchEntering = true;
        this.update();
        void this.doEnterSketch(kind, offset);
    };

    protected readonly handleEnterSketchDraft = (draft: DatumDraft, offset: number): void => {
        this.sketchSetupVisible = false;
        this.sketchEntering = true;
        this.update();
        const extra = draft.kind === 'midplane' ? { faces: [...draft.faces] } : { points: [...draft.points] };
        void this.doEnterSketch(draft.kind, offset, undefined, extra);
    };

    protected readonly handleExitSketch = (): Promise<void> => this.doExitSketch();

    /** Tab toggles sketch mode. */
    protected readonly handleToggleSketchMode = (): void => {
        if (this.sketchEntering) {
            return;
        }
        if (this.sketchController?.isActive) {
            void this.handleExitSketch();
        } else if (this.documentStore.hasDocument && !this.loading && !this.sketchSetupVisible) {
            this.startSketchSetup();
        }
    };

    /** True while the document template picker is open. */
    templatePickerOpen = false;

    protected readonly handleNewDocument = (): void => {
        this.templatePickerOpen = true;
        this.update();
    };

    protected readonly handleCreateDocument = (templateId: string): void => {
        this.documentStore.createDocument('Untitled', templateId);
        this.editingSketchId = undefined;
        this.templatePickerOpen = false;
        // A fresh document has no build to be stale against.
        this.buildStale = false;
        this.rebuildTracker.reset();
        this.update();
    };

    protected readonly handleCancelTemplatePicker = (): void => {
        this.templatePickerOpen = false;
        this.update();
    };

    protected readonly handleSaveDocument = (): Promise<void> => this.saveDocument(false);

    protected readonly handleSaveDocumentAs = (): Promise<void> => this.saveDocument(true);

    protected readonly handleEditFeature = (id: string, params: FeatureParams): void => {
        const result = this.documentStore.updateFeatureParams(id, params);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to update feature.');
            return;
        }
        this.scheduleDocumentRebuild([id]);
    };

    protected readonly handleAddFeature = (type: FeatureType, params: FeatureParams): void => {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return;
        }
        const paramsRecord = params as Record<string, unknown>;

        // Boolean, dress-up, pattern/mirror/hole, pipe, loft, and translate features do not consume a sketch.
        const isBoolean = type === 'booleanFuse' || type === 'booleanCut' || type === 'booleanCommon';
        const isDressUp = type === 'fillet' || type === 'chamfer' || type === 'draft' || type === 'shell';
        const isPatternOrMirrorOrHole = type === 'linearPattern' || type === 'circularPattern' || type === 'mirror' || type === 'hole';
        const sketchFree = isBoolean || isDressUp || isPatternOrMirrorOrHole || type === 'pipe' || type === 'loft' || type === 'translate';
        const sketchId = sketchFree ? undefined : this.documentStore.selection.selectedSketchId;
        if (!sketchFree && sketchId === undefined) {
            this.messageService.warn('Select a closed sketch before adding a solid feature.');
            return;
        }

        let bodyId: string | undefined;
        if (isBoolean) {
            bodyId = typeof paramsRecord.targetBody === 'string' ? paramsRecord.targetBody : undefined;
        } else {
            bodyId = typeof paramsRecord.bodyId === 'string' ? paramsRecord.bodyId : undefined;
        }

        const isAdditive =
            type === 'pad' || type === 'revolve' || type === 'sweep' || type === 'pipe' || type === 'loft' || type === 'helicalSweep';
        if (bodyId === undefined && isAdditive) {
            // Create a new body for the additive feature.
            const label = typeof paramsRecord.label === 'string' ? paramsRecord.label : undefined;
            const bodyResult = this.documentStore.addBody(`${type} ${doc.bodies.length + 1}`, label);
            if (!bodyResult.success) {
                this.messageService.error(bodyResult.error || 'Failed to create body.');
                return;
            }
            bodyId = bodyResult.value;
        } else if (bodyId === undefined && (type === 'pocket' || type === 'groove' || type === 'translate')) {
            this.messageService.warn(`${type} requires an existing body.`);
            return;
        } else if (bodyId === undefined && isPatternOrMirrorOrHole) {
            this.messageService.warn(`${type} requires an existing body.`);
            return;
        }

        if (bodyId === undefined) {
            this.messageService.error('No target body selected for the feature.');
            return;
        }

        // Apply body label from the dialog when an existing body is reused.
        if (!isBoolean && typeof paramsRecord.label === 'string' && paramsRecord.label.length > 0) {
            const body = doc.bodies.find((b) => b.id === bodyId);
            if (body !== undefined && body.label !== paramsRecord.label) {
                const labelResult = this.documentStore.setBodyLabel(bodyId, paramsRecord.label);
                if (!labelResult.success) {
                    this.messageService.error(labelResult.error || 'Failed to set body label.');
                    return;
                }
            }
        }

        let dependsOn: string[] = [];
        if (isBoolean) {
            const toolBodies = Array.isArray(paramsRecord.toolBodies) ? (paramsRecord.toolBodies as string[]) : [];
            const deps = new Set<string>();
            const targetTip = this.resolveBodyTipFeature(bodyId);
            if (targetTip !== undefined) {
                deps.add(targetTip);
            }
            for (const toolBody of toolBodies) {
                const tip = this.resolveBodyTipFeature(toolBody);
                if (tip !== undefined) {
                    deps.add(tip);
                }
            }
            dependsOn = [...deps];
        } else {
            const deps = new Set<string>();
            const implied = computeDependsOn(type, bodyId, doc.features);
            if (implied !== undefined) {
                deps.add(implied);
            }
            if ((type === 'pocket' || type === 'groove' || isPatternOrMirrorOrHole) && deps.size === 0) {
                this.messageService.warn(`${type} requires a prior solid feature on the selected body.`);
                return;
            }
            if (isPatternOrMirrorOrHole && typeof paramsRecord.source === 'string' && paramsRecord.source.length > 0) {
                deps.add(paramsRecord.source);
            }
            dependsOn = [...deps];
        }

        const featureParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(paramsRecord)) {
            if (key !== 'bodyId' && key !== 'label') {
                featureParams[key] = value;
            }
        }

        const feature: FeatureDef = {
            id: uniqueFeatureId(doc),
            name: `${type} ${doc.features.length + 1}`,
            type,
            body: bodyId,
            sketchId,
            params: featureParams as FeatureParams,
            suppressed: false,
            dependsOn
        };
        const result = this.documentStore.addFeature(feature);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to add feature.');
            return;
        }
        this.scheduleDocumentRebuild([feature.id]);
    };

    protected readonly handleEditSketch = (sketchId: string): void => {
        const doc = this.documentStore.document;
        const sketch = doc?.sketches.find((s) => s.id === sketchId);
        if (sketch === undefined || doc === undefined) {
            return;
        }
        this.editingSketchId = sketchId;
        this.sketchSetupVisible = true;
        this.update();
    };

    protected readonly handleStartFacePick = (offset: number): void => {
        this.facePickMode = 'sketchDatum';
        this.facePickOffset = offset;
        this.facePickFeatureId = undefined;
        this.update();
    };

    protected readonly handleStartExternalGeometryPick = (featureId: string): void => {
        this.facePickMode = 'externalGeometry';
        this.facePickFeatureId = featureId;
        this.update();
    };

    protected readonly handleCancelFacePick = (): void => {
        this.facePickMode = undefined;
        this.facePickFeatureId = undefined;
        this.update();
    };

    private resolveBodyTipFeature(bodyId: string): string | undefined {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return undefined;
        }
        const solidFeatures: FeatureDef['type'][] = [
            'pad',
            'pocket',
            'revolve',
            'groove',
            'sweep',
            'pipe',
            'fillet',
            'chamfer',
            'draft',
            'shell',
            'mirror',
            'linearPattern',
            'circularPattern',
            'hole',
            'primitive',
            'multiTransform',
            'defeature',
            'translate',
            'booleanFuse',
            'booleanCut',
            'booleanCommon'
        ];
        for (let i = doc.features.length - 1; i >= 0; i--) {
            const feature = doc.features[i];
            if (!feature.suppressed && solidFeatures.includes(feature.type) && feature.body === bodyId) {
                return feature.id;
            }
        }
        return undefined;
    }

    protected readonly handleFacePick = (hit: FacePickHit): void => {
        if (this.facePickMode === 'sketchDatum') {
            const ref = buildTopologyRef(String(hit.solidId), hit, (bodyId) => this.resolveBodyTipFeature(bodyId));
            if (ref === undefined) {
                this.messageService.error('Selected face has no geometric fingerprint; rebuild the model first.');
                this.facePickMode = undefined;
                this.update();
                return;
            }
            this.facePickMode = undefined;
            void this.doEnterSketch('face', this.facePickOffset, ref);
            return;
        }
        if (this.facePickMode === 'externalGeometry') {
            const featureId = this.facePickFeatureId;
            if (featureId === undefined) {
                this.messageService.error('No target feature selected for external geometry.');
                this.facePickMode = undefined;
                this.update();
                return;
            }
            const ref = buildTopologyRef(featureId, hit, (bodyId) => this.resolveBodyTipFeature(bodyId));
            if (ref === undefined) {
                this.messageService.error('Selected face has no geometric fingerprint; rebuild the model first.');
                return;
            }
            const sketchId = this.editingSketchId;
            if (sketchId === undefined) {
                this.messageService.error('No active sketch for external geometry.');
                this.facePickMode = undefined;
                this.update();
                return;
            }
            const result = this.documentStore.addExternalRef(sketchId, ref);
            if (!result.success) {
                this.messageService.error(result.error || 'Failed to add external geometry reference.');
                return;
            }
            const session = this.sketchController?.getSession();
            session?.addExternalRef(ref);
            this.facePickMode = undefined;
            this.facePickFeatureId = undefined;
            this.scheduleDocumentRebuild();
            this.update();
        }
    };

    protected readonly handleFacePickCancel = (): void => {
        this.handleCancelFacePick();
    };

    protected readonly handleStartDressUpPick = (
        type: FeatureType,
        selecting: 'edge' | 'face',
        callback: (ref: TopologyRef) => void,
        tangentChain?: boolean
    ): void => {
        this.dressUpPickMode = dressUpPickRequest(type, selecting, tangentChain);
        this.dressUpPickCallback = callback;
        this.update();
    };

    protected readonly handleDressUpPickCancel = (): void => {
        this.dressUpPickMode = undefined;
        this.dressUpPickCallback = undefined;
        this.update();
    };

    protected readonly handleEdgePick = (hit: EdgePickHit, edgeLines?: readonly THREE.Line[]): void => {
        if (this.dressUpPickMode?.selecting === 'edge' && this.dressUpPickMode.tangentChain === true) {
            this.handleTangentChainEdgePick(hit, edgeLines);
            return;
        }
        const ref = buildEdgeTopologyRef(String(hit.solidId), hit, (bodyId) => this.resolveBodyTipFeature(bodyId));
        if (ref === undefined) {
            this.messageService.error('Selected edge has no geometric fingerprint; rebuild the model first.');
            return;
        }
        this.dressUpPickCallback?.(ref);
        this.dressUpPickMode = undefined;
        this.dressUpPickCallback = undefined;
        this.update();
    };

    /**
     * Expand one picked edge to its tangent-connected run on the same solid.
     *
     * Each chained line becomes its own fingerprint-backed ref and the dialog
     * callback fires once per ref (its list appends). Refs are deduped by
     * producing feature + fingerprint so a chain cannot add the same geometry
     * twice; edges without a fingerprint are skipped with one warning.
     */
    private handleTangentChainEdgePick(hit: EdgePickHit, edgeLines: readonly THREE.Line[] | undefined): void {
        const hits = edgeLines === undefined ? [hit] : expandTangentEdgeChain(hit, edgeLines);
        const refs: TopologyRef[] = [];
        const seen = new Set<string>();
        let missingFingerprints = 0;
        for (const candidate of hits) {
            const ref = buildEdgeTopologyRef(String(candidate.solidId), candidate, (bodyId) => this.resolveBodyTipFeature(bodyId));
            if (ref === undefined) {
                missingFingerprints++;
                continue;
            }
            const key = `${ref.featureId}\u0000${JSON.stringify(ref.fingerprint)}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            refs.push(ref);
        }
        if (refs.length === 0) {
            this.messageService.error('Selected edge has no geometric fingerprint; rebuild the model first.');
            return;
        }
        if (missingFingerprints > 0) {
            this.messageService.warn(
                `${missingFingerprints} tangent-chain edge(s) have no geometric fingerprint and were skipped; rebuild the model first.`
            );
        }
        for (const ref of refs) {
            this.dressUpPickCallback?.(ref);
        }
        this.dressUpPickMode = undefined;
        this.dressUpPickCallback = undefined;
        this.update();
    }

    protected readonly handleFacePickDressUp = (hit: FacePickHit): void => {
        const ref = buildTopologyRef(String(hit.solidId), hit, (bodyId) => this.resolveBodyTipFeature(bodyId));
        if (ref === undefined) {
            this.messageService.error('Selected face has no geometric fingerprint; rebuild the model first.');
            return;
        }
        this.dressUpPickCallback?.(ref);
        this.dressUpPickMode = undefined;
        this.dressUpPickCallback = undefined;
        this.update();
    };

    protected readonly handleStartHolePick = (callback: (ref: TopologyRef, uv: [number, number]) => void): void => {
        this.holePickMode = { callback };
        this.update();
    };

    protected readonly handleHolePickCancel = (): void => {
        this.holePickMode = undefined;
        this.update();
    };

    protected readonly handleHolePick = (hit: FacePickHit): void => {
        const ref = buildTopologyRef(String(hit.solidId), hit, (bodyId) => this.resolveBodyTipFeature(bodyId));
        if (ref === undefined) {
            this.messageService.error('Selected face has no geometric fingerprint; rebuild the model first.');
            return;
        }
        const uv = projectHitToFaceUv(hit);
        if (uv === undefined) {
            this.messageService.error('Selected face has no usable workplane; pick a planar face.');
            return;
        }
        this.holePickMode?.callback(ref, uv);
        this.holePickMode = undefined;
        this.update();
    };

    protected readonly handleStartCurvePick = (callback: (curveId: string) => void): void => {
        this.curvePickMode = { callback };
        this.update();
    };

    protected readonly handleCurvePickCancel = (): void => {
        this.curvePickMode = undefined;
        this.update();
    };

    protected readonly handleCurvePick = (curveId: string): void => {
        const doc = this.documentStore.document;
        const resolved = doc !== undefined ? resolveCurvePick(doc.curves, curveId) : undefined;
        if (resolved === undefined) {
            this.messageService.warn('The picked curve no longer exists in this document.');
            this.curvePickMode = undefined;
            this.update();
            return;
        }
        this.curvePickMode?.callback(resolved);
        this.curvePickMode = undefined;
        this.update();
    };

    /**
     * Broker callback: the Drawing Sheet dimension tool entered or left
     * viewport edge-pick mode. Entering resets the banner progress; leaving
     * (commit or Cancel) drops the mode.
     */
    protected readonly handleDrawingDimensionPickRequest = (request: DrawingDimensionPickRequest | undefined): void => {
        this.drawingDimensionPickMode = request !== undefined ? { kind: request.kind, picked: 0 } : undefined;
        this.update();
    };

    /**
     * Viewport click in drawing-dimension pick mode: the edge fingerprint
     * becomes a `TopologyRef` published to the sheet, which accumulates and
     * commits via `addDimension`. Guarded against fingerprint-less geometry
     * like the dress-up path; the mode stays active for the next pick.
     */
    protected readonly handleDrawingDimensionEdgePick = (hit: EdgePickHit): void => {
        if (this.drawingDimensionPickMode === undefined || getDrawingDimensionPickRequest() === undefined) {
            return;
        }
        const ref = buildEdgeTopologyRef(String(hit.solidId), hit, (bodyId) => this.resolveBodyTipFeature(bodyId));
        if (ref === undefined) {
            this.messageService.error('Selected edge has no geometric fingerprint; rebuild the model first.');
            return;
        }
        this.drawingDimensionPickMode = { ...this.drawingDimensionPickMode, picked: this.drawingDimensionPickMode.picked + 1 };
        publishDrawingDimensionEdgeHit(ref);
        this.update();
    };

    /** Viewport Cancel (banner button, right-click, Escape) for drawing-dimension picking. */
    protected readonly handleDrawingDimensionEdgePickCancel = (): void => {
        this.drawingDimensionPickMode = undefined;
        cancelDrawingDimensionPick();
        this.update();
    };

    /** Enter viewport connector-pick mode for one side of the mate dialog. */
    protected readonly handleStartConnectorPick = (side: 'A' | 'B'): void => {
        this.connectorPickMode = { side };
        this.update();
    };

    protected readonly handleConnectorPickCancel = (): void => {
        this.connectorPickMode = undefined;
        this.update();
    };

    /** Viewport click in connector-pick mode: guarded, then fed to the dialog. */
    protected readonly handleConnectorPick = (connectorId: string): void => {
        const assembly = this.documentStore.document !== undefined ? getAssemblySection(this.documentStore.document) : undefined;
        const resolved = assembly !== undefined ? resolveConnectorPick(assembly.connectors, assembly.instances, connectorId) : undefined;
        if (resolved === undefined) {
            this.messageService.warn('The picked connector no longer exists in this document.');
            this.connectorPickMode = undefined;
            this.update();
            return;
        }
        if (this.connectorPickMode?.side === 'B') {
            this.mateConnectorB = resolved.id;
        } else {
            this.mateConnectorA = resolved.id;
        }
        this.connectorPickMode = undefined;
        this.refreshMatePreview();
        this.update();
    };

    /** Recompute the ghosted mate preview (both connectors at solved poses). */
    private refreshMatePreview(): void {
        // The preview renders through `updateModel`'s connector-triad path in
        // the scene closure; here we only drop it when the dialog closes or
        // the toggle clears (failures clear silently per the preview contract).
        if (!this.matePreviewEnabled) {
            return;
        }
        this.update();
    }

    protected readonly handleMatePreviewChange = (enabled: boolean): void => {
        this.matePreviewEnabled = enabled;
        this.update();
    };

    protected readonly handleOpenMateDialog = (): void => {
        this.mateDialogOpen = true;
        this.mateConnectorA = undefined;
        this.mateConnectorB = undefined;
        this.update();
    };

    protected readonly handleCloseMateDialog = (): void => {
        this.mateDialogOpen = false;
        this.connectorPickMode = undefined;
        this.matePreviewEnabled = false;
        this.update();
    };

    protected readonly handleMateSubmit = (draft: MateDraft): void => {
        const result = this.documentStore.addMate(draft.type, draft.instanceA, draft.connectorA, draft.instanceB, draft.connectorB);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to add mate.');
            return;
        }
        this.mateDialogOpen = false;
        this.connectorPickMode = undefined;
        this.matePreviewEnabled = false;
        this.update();
    };

    /** Instance list: add a part instance (grounding stays explicit). */
    protected readonly handleAddInstance = (part: string): void => {
        const result = this.documentStore.addInstance(part);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to add instance.');
        }
    };

    /** Instance list: Ground-here action writing `groundedInstanceId`. */
    protected readonly handleGroundInstance = (instanceId: string): void => {
        const result = this.documentStore.setGrounded(instanceId);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to ground instance.');
        }
    };

    protected readonly handleDeleteInstance = (instanceId: string): void => {
        const result = this.documentStore.deleteInstance(instanceId);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to delete instance.');
        }
    };

    protected readonly handleRenameInstance = (instanceId: string, newId: string): void => {
        if (newId === '' || newId === instanceId) {
            return;
        }
        const result = this.documentStore.renameInstance(instanceId, newId);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to rename instance.');
        }
    };

    /**
     * Instance list / outline row click: select the instance's solids in the
     * viewport via the state manager (B1 `<instanceId>/…` selector keys; a
     * no-op until those land).
     */
    protected readonly handleSelectInstance = (instanceId: string): void => {
        const solids = instanceSolidIds(this.stateManager.model?.result.selectorMap, instanceId);
        if (solids.length === 0) {
            return;
        }
        this.stateManager.setSelection({ solidId: solids[0], solidIds: solids });
    };

    /**
     * Dialog-driven ghosted preview: the request replaces any previous one;
     * undefined clears the preview. Stale build results are dropped by token.
     */
    protected readonly handleFeaturePreviewChange = (request: FeaturePreviewRequest | undefined): void => {
        const token = ++this.featurePreviewToken;
        if (request === undefined) {
            if (this.previewTessData !== undefined) {
                this.previewTessData = undefined;
                this.update();
            }
            return;
        }
        void this.buildFeaturePreview(request, token);
    };

    /**
     * Build the ghosted preview through the normal geometry-service document
     * path: a tentative mini-document holding only what the draft feature
     * references is written to a temp file, built, and its tessellation
     * rendered in the preview group with the ghost material. Failures clear
     * the preview silently — the dialog's validation is the text feedback.
     */
    private async buildFeaturePreview(request: FeaturePreviewRequest, token: number): Promise<void> {
        const doc = this.documentStore.document;
        const previewDoc = doc !== undefined ? buildFeaturePreviewDocument(doc, request) : undefined;
        if (previewDoc === undefined) {
            if (token === this.featurePreviewToken && this.previewTessData !== undefined) {
                this.previewTessData = undefined;
                this.update();
            }
            return;
        }
        const uri = new URI(`file:///tmp/nuke-cad-preview-${token}-${Date.now()}.nuke-cad`);
        try {
            await this.fileService.write(uri, JSON.stringify(previewDoc));
            // Preview documents are transient: never write a cache sidecar.
            const result = await this.backendService.buildDocument({ scriptPath: uri.path.toString(), useCache: false });
            if (!result.success || result.tessPath === undefined) {
                throw new Error(result.error ?? 'Preview build produced no tessellation.');
            }
            const content = await this.fileService.readFile(new URI(result.tessPath));
            if (token !== this.featurePreviewToken) {
                return;
            }
            this.previewTessData = await parseTessellationAsync(content.value.toString());
            if (token !== this.featurePreviewToken) {
                return;
            }
            this.update();
        } catch (error) {
            console.warn('[CadViewport] Feature preview build failed:', error);
            if (token === this.featurePreviewToken && this.previewTessData !== undefined) {
                this.previewTessData = undefined;
                this.update();
            }
        } finally {
            this.fileService.delete(uri).catch(() => undefined);
        }
    }

    /** Dialog closed or committed: drop pick modes and the ghosted preview. */
    protected readonly handleCancelFeatureCreation = (): void => {
        this.featureCreationType = undefined;
        this.featureCreationBodyId = undefined;
        this.editingFeatureId = undefined;
        this.dressUpPickMode = undefined;
        this.dressUpPickCallback = undefined;
        this.holePickMode = undefined;
        this.curvePickMode = undefined;
        this.connectorPickMode = undefined;
        this.featurePreviewToken++;
        this.previewTessData = undefined;
        this.update();
    };

    protected readonly handleRebuildDocument = (): Promise<void> => this.rebuildDocument();

    /**
     * Pin/unpin a ribbon command inline. Writes the whole user-scoped array
     * with known ids only; unknown pins and duplicates never persist.
     */
    protected readonly handleToggleRibbonPin = (commandId: string): void => {
        if (!CAD_COMMAND_IDS.has(commandId)) {
            return;
        }
        const current = this.preferences['nukeCad.ribbonPins'] ?? [];
        const next = new Set(current.filter((id) => CAD_COMMAND_IDS.has(id)));
        if (next.has(commandId)) {
            next.delete(commandId);
        } else {
            next.add(commandId);
        }
        void this.preferenceService.set('nukeCad.ribbonPins', Array.from(next), PreferenceScope.User);
    };

    @postConstruct()
    protected init(): void {
        this.id = CadViewportWidget.ID;
        this.title.label = CadViewportWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-nuke-cad-cube';

        this.toDispose.push(this.stateManager.onModelChange((model) => this.handleModelChange(model)));
        this.toDispose.push(this.monacoWorkspace.onDidSaveTextDocument((document) => this.onModelScriptSaved(document)));
        this.toDispose.push(Disposable.create(() => this.clearSaveRebuildTimer()));
        this.toDispose.push(Disposable.create(this.documentStore.onChange(() => this.onDocumentChange())));
        // Display precision is a rendering-only preference: re-render the React
        // chrome (measure popover props) and let the mounted scene refresh its
        // overlay labels through `setMeasurementDecimals`. Ribbon labels/pins,
        // world-origin axis visibility, and material coloring are pure
        // React/scene chrome, so the same subscription re-renders them.
        this.toDispose.push(
            this.preferences.onPreferenceChanged((event) => {
                if (
                    event.preferenceName === 'nukeCad.lengthDecimals' ||
                    event.preferenceName === 'nukeCad.angleDecimals' ||
                    event.preferenceName === 'nukeCad.ribbonLabels' ||
                    event.preferenceName === 'nukeCad.ribbonPins' ||
                    event.preferenceName === 'nukeCad.appearancePresets' ||
                    event.preferenceName === 'nukeCad.colorByMaterial' ||
                    event.preferenceName === 'nukeCad.showOriginAxes' ||
                    event.preferenceName === 'nukeCad.showOriginX' ||
                    event.preferenceName === 'nukeCad.showOriginY' ||
                    event.preferenceName === 'nukeCad.showOriginZ'
                ) {
                    this.update();
                }
            })
        );
        // Drawing-dimension edge picks arrive from the Drawing Sheet widget
        // through the `edge-picker` broker (no shared service to dispose).
        this.toDispose.push(Disposable.create(onDrawingDimensionPickRequest((request) => this.handleDrawingDimensionPickRequest(request))));
        this.update();
    }

    /** Show the datum-plane picker and prepare to enter sketch mode. */
    readonly startSketchSetup = (): void => {
        if (!this.documentStore.hasDocument) {
            this.documentStore.createDocument('Untitled');
        }
        this.editingSketchId = undefined;
        this.sketchSetupVisible = true;
        this.update();
    };

    /** Enter sketch mode on the chosen datum plane. */
    enterSketch(kind: DatumKind, offset: number): void {
        this.handleEnterSketch(kind, offset);
    }

    /** Exit the active sketch mode. */
    exitSketch(): void {
        void this.handleExitSketch();
    }

    /** Open an existing sketch for editing. */
    editSketch(sketchId: string): void {
        this.handleEditSketch(sketchId);
    }

    /**
     * Save the current camera pose as a named view.
     *
     * Capture goes through the mounted scene's camera API; the store owns
     * name/vector validation and undo. Display-only: never triggers a build.
     */
    saveNamedView(name: string): DocumentMutationResult<string> {
        if (this.cameraApi === undefined) {
            const error = 'Open the CAD viewport before saving a named view.';
            this.messageService.error(error);
            return { success: false, error };
        }
        const result = this.documentStore.addNamedView({ name, ...this.cameraApi.getCameraState() });
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to save the named view.');
        }
        return result;
    }

    /**
     * Restore a saved named view by id.
     *
     * Missing ids and an unmounted scene warn instead of throwing; the stored
     * pose is copied verbatim (no distance clamping).
     */
    restoreNamedView(id: string): void {
        const view = this.documentStore.document?.views?.find((entry) => entry.id === id);
        if (view === undefined) {
            this.messageService.warn(`Named view '${id}' not found.`);
            return;
        }
        if (this.cameraApi === undefined) {
            this.messageService.warn('Open the CAD viewport before restoring a named view.');
            return;
        }
        this.cameraApi.setCameraState({ position: view.position, target: view.target, up: view.up });
    }

    /** Create a new document and open the viewport. */
    newDocument(): void {
        this.handleNewDocument();
    }

    /** Save the active document, prompting for a path when needed. */
    async saveDocument(forceDialog = false): Promise<void> {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            this.messageService.warn('No CAD document is active.');
            return;
        }
        let uri = this.documentStore.uri !== undefined && !forceDialog ? new URI(this.documentStore.uri) : undefined;
        if (uri === undefined) {
            const existingUri = this.documentStore.uri !== undefined ? new URI(this.documentStore.uri) : undefined;
            uri = await this.fileDialogService.showSaveDialog({
                title: 'Save CAD Document',
                inputValue: existingUri?.path.base ?? `${doc.name}.nuke-cad`,
                filters: { 'CAD Document': ['nuke-cad'] }
            });
            if (uri === undefined) {
                return;
            }
            uri = uri.withPath(ensureNukeCadExtension(uri.path.toString()));
        }
        const json = this.documentStore.toJson();
        if (json === undefined) {
            return;
        }
        await this.fileService.write(uri, json);
        this.documentStore.setUri(uri.toString());
        this.documentStore.markSaved();
        this.messageService.info(`Saved ${uri.path.base}`);
    }

    /** Open the feature creation dialog for the given feature type. */
    startFeatureCreation(type: FeatureType): void {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            this.messageService.warn('Open or create a document before adding features.');
            return;
        }

        const isBoolean = type === 'booleanFuse' || type === 'booleanCut' || type === 'booleanCommon';
        const isDressUp = type === 'fillet' || type === 'chamfer' || type === 'draft' || type === 'shell';
        const isPatternOrMirrorOrHole = type === 'linearPattern' || type === 'circularPattern' || type === 'mirror' || type === 'hole';
        if (
            !isBoolean &&
            !isDressUp &&
            !isPatternOrMirrorOrHole &&
            type !== 'pipe' &&
            type !== 'loft' &&
            type !== 'translate' &&
            this.documentStore.selection.selectedSketchId === undefined
        ) {
            this.messageService.warn('Select a closed sketch in the feature tree before adding a solid feature.');
            return;
        }
        this.editingFeatureId = undefined;
        this.featureCreationType = type;
        // Preselect the dialog target body from the viewport selection so a
        // selected solid opens Move/dress-up on its own body (the dialog
        // still offers every body; stale ids fall back to the first body).
        const selectedSolidId = this.stateManager.selection.solidId;
        const selectedBodyId =
            selectedSolidId !== undefined
                ? this.stateManager.solidSummaries.find((summary) => summary.solidId === selectedSolidId)?.bodyId
                : undefined;
        this.featureCreationBodyId =
            selectedBodyId !== undefined && doc.bodies.some((body) => body.id === selectedBodyId) ? selectedBodyId : undefined;
        this.update();
    }

    /** Open the feature dialog in edit mode for an existing feature. */
    startFeatureEdit(id: string): void {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return;
        }
        const feature = doc.features.find((f) => f.id === id);
        if (feature === undefined) {
            this.messageService.warn('Feature not found.');
            return;
        }
        this.editingFeatureId = id;
        this.featureCreationBodyId = undefined;
        this.featureCreationType = feature.type;
        this.update();
    }

    /**
     * Palette entry point for EDIT_FEATURE: the command palette cannot supply
     * a feature id, so edit the feature currently selected in the document
     * (e.g. clicked in the Feature Tree), or explain why nothing happens.
     */
    startFeatureEditForSelection(): void {
        const selectedId = this.documentStore.selection.selectedFeatureId;
        if (selectedId === undefined) {
            this.messageService.warn('Select a feature in the Feature Tree first.');
            return;
        }
        this.startFeatureEdit(selectedId);
    }

    /** Export the active document as a one-way build123d Python script. */
    async exportPython(): Promise<void> {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            this.messageService.warn('No CAD document is active.');
            return;
        }
        const { generatePythonScript } = await import('../../../common/python-codegen.js');
        const script = generatePythonScript(doc);
        const uri = await this.fileDialogService.showSaveDialog({
            title: 'Export CAD Document as Python',
            filters: { 'Python Script': ['py'] }
        });
        if (uri === undefined) {
            return;
        }
        await this.fileService.write(uri, script);
        this.messageService.info(`Exported Python script to ${uri.path.base}`);
    }

    /**
     * Rebuild the active document through the backend.
     *
     * With `restoreFromCache` (document open after a memory-cache miss), an
     * otherwise-full build goes through the partial RPC with an empty dirty
     * set instead: clean features restore from the zip sidecar and only
     * tessellation runs, with per-feature fallback to execution on any miss.
     */
    async rebuildDocument(restoreFromCache = false): Promise<void> {
        if (this.rebuildPromise !== undefined) {
            this.rebuildPending = true;
            return;
        }
        this.rebuildPromise = this.doRebuildDocument(restoreFromCache);
        try {
            await this.rebuildPromise;
        } finally {
            this.rebuildPromise = undefined;
            if (this.rebuildPending) {
                this.rebuildPending = false;
                this.scheduleDocumentRebuild();
            }
        }
    }

    private async doRebuildDocument(restoreFromCache = false): Promise<void> {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            this.messageService.warn('No CAD document is active.');
            return;
        }
        if (this.documentStore.dirty || this.documentStore.uri === undefined) {
            await this.saveDocument();
            if (this.documentStore.uri === undefined) {
                return; // User cancelled the save dialog.
            }
        }
        const filePath = new URI(this.documentStore.uri).path.toString();
        if (doc.features.length === 0 && doc.curves.length === 0) {
            // Nothing to build yet (e.g. a fresh document with only sketches):
            // skip the backend round-trip — it reports "produced no solids" —
            // and present the empty state instead of a failure.
            this.buildWarnings = [];
            this.dismissBuildError();
            this.documentStore.setFeatureResults([]);
            this.rebuildTracker.succeed();
            this.buildStale = false;
            this.messageService.info('Nothing to build yet — add a solid feature first.');
            return;
        }
        // Drain the accumulated dirty set into this build; unknown scope (or a
        // fresh open) yields an empty list → full build below.
        const attempted = this.rebuildTracker.beginBuild() ?? [];
        let plan: string[] | undefined;
        try {
            plan = planDirtyRebuild(doc, attempted).featureIds;
        } catch (error) {
            console.warn('[CadViewport] Dirty-plan unavailable, falling back to full build:', error);
            plan = undefined;
        }
        const usePartial = plan !== undefined && shouldUsePartialPlan(plan, doc.features.length);
        // Cross-session open fast path: with a fresh tracker the plan is empty
        // (would-be-full), so restore everything from the zip sidecar instead —
        // clean features deserialize with zero booleans and only tessellation
        // runs. Any miss executes that feature; without partial support the
        // transport fallback runs the full build.
        const restoreAll = restoreFromCache && !usePartial;
        const token = ++this.rebuildToken;
        this.setLoading(
            true,
            usePartial
                ? `Rebuilding ${plan!.length} of ${doc.features.length} features...`
                : restoreAll
                  ? 'Restoring cached geometry...'
                  : 'Rebuilding CAD geometry...'
        );
        // The backend rewrites <stem>.tess.json at the same path, so a rebuild
        // must not trust the path-equality check in handleModelChange. Keep
        // tessData on screen (the old model) until the new tessellation lands.
        this.invalidateTessellation();
        try {
            const result = usePartial
                ? await this.buildPartialWithFallback(filePath, plan!)
                : restoreAll
                  ? await this.buildPartialWithFallback(filePath, [])
                  : await this.backendService.buildDocument({ scriptPath: filePath });
            if (token !== this.rebuildToken) {
                // Cancelled or superseded while in flight: keep the attempted
                // ids dirty so the next rebuild retries them.
                this.rebuildTracker.noteEdit(attempted);
                return;
            }
            this.pendingPartialJobId = undefined;
            this.documentStore.setFeatureResults(result.featureResults ?? []);
            this.documentStore.setProjectedPrimitives(result.projectedPrimitives);
            this.documentStore.setReferenceResults(result.referenceResults ?? []);
            this.buildWarnings = result.warnings ?? [];
            if (result.success) {
                this.rebuildTracker.succeed();
                this.buildStale = false;
                this.stateManager.setModel({ scriptPath: filePath, result, manifest: result.regionManifest });
                this.messageService.info(`CAD rebuild: ${result.solidCount ?? 0} solids, ${result.triangleCount ?? 0} triangles`);
                await this.cacheSuccessfulBuild(doc, result);
            } else {
                const message = result.error || 'Document rebuild failed.';
                this.rebuildTracker.fail(message, attempted);
                this.showBuildError(message);
                this.messageService.error(message);
            }
        } catch (error) {
            if (token !== this.rebuildToken) {
                this.rebuildTracker.noteEdit(attempted);
                return;
            }
            this.pendingPartialJobId = undefined;
            const message = error instanceof Error ? error.message : String(error);
            this.rebuildTracker.fail(message, attempted);
            this.showBuildError(message);
            this.messageService.error(message);
        }
    }

    /**
     * Partial rebuild with a one-time fallback: when the backend does not
     * (yet) implement ``buildFeaturesPartial`` the transport throws and the
     * existing full-build path runs instead. A reached backend returning
     * ``success: false`` is a real build error and is NOT retried as full.
     *
     * The spinner claim is corrected in place before the full build: the
     * caller set a "N of M" message optimistically, so a fallback must say
     * that every feature is rebuilding (once per viewport instance warned).
     */
    private async buildPartialWithFallback(filePath: string, featureIds: string[]): Promise<GeometryBuildResult> {
        const jobId = `cad-partial-${Date.now()}-${this.partialJobCounter++}`;
        this.pendingPartialJobId = jobId;
        try {
            // Defensive: a third-party service may still omit the optional RPC.
            const partial = (this.backendService as Partial<NukeCadBackendService>).buildFeaturesPartial;
            if (typeof partial !== 'function') {
                throw new Error('buildFeaturesPartial is not implemented by the backend service.');
            }
            return await partial.call(this.backendService, {
                scriptPath: filePath,
                featureIds,
                cacheDir: partialCacheDirForDocument(filePath),
                sizeCapMB: this.preferences['nukeCad.resultCacheSizeMB'],
                jobId
            });
        } catch (error) {
            const doc = this.documentStore?.document;
            const featureCount = doc?.features.length ?? 0;
            if (!this.partialFallbackWarned) {
                this.partialFallbackWarned = true;
                console.warn(`[CadViewport] Partial rebuild unavailable for ${featureCount} features, falling back to full build:`, error);
            }
            if (doc !== undefined) {
                // Replace the caller's optimistic "N of M" claim before the
                // full build starts so the spinner never overstates the work.
                this.setLoading(true, `Rebuilding all ${featureCount} features (cache unavailable)`);
            }
            this.pendingPartialJobId = undefined;
            return this.backendService.buildDocument({ scriptPath: filePath });
        }
    }

    /**
     * Cancel the in-flight document rebuild, if any.
     *
     * Signals the backend job, drops the late result by token, and returns
     * the tracker to stale (queued edits preserved) or cancelled. Existing
     * geometry stays on screen; no error banner — cancellation is not a
     * failure. In auto mode a still-stale tracker schedules a follow-up.
     */
    async cancelDocumentRebuild(): Promise<void> {
        this.rebuildToken++;
        const jobId = this.pendingPartialJobId;
        this.pendingPartialJobId = undefined;
        if (jobId !== undefined) {
            try {
                await this.backendService.cancelJob(jobId);
            } catch (error) {
                console.warn('[CadViewport] Partial-rebuild cancel failed:', error);
            }
        }
        this.rebuildTracker.cancel();
        this.setLoading(false);
        if (this.rebuildTracker.getState().status === 'stale' && this.preferences['nukeCad.rebuildOnEdit'] !== 'manual') {
            this.scheduleDocumentRebuild([]);
        }
    }

    /**
     * Record a successful build's tessellation + content keys in the
     * in-session memory cache for the open fast path. Best-effort: failures
     * only skip the fast path, never the build.
     */
    private async cacheSuccessfulBuild(doc: NukeCadDocument, result: GeometryBuildResult): Promise<void> {
        if (!result.success || result.tessPath === undefined) {
            return;
        }
        try {
            const content = await this.fileService.readFile(new URI(result.tessPath));
            const table = computeResultCacheKeys(doc, {
                builderVersion: RESULT_CACHE_BUILDER_VERSION,
                ocpVersion: RESULT_CACHE_OCP_UNKNOWN
            });
            this.resultCache.set(cacheKeyForDocument(this.documentStore.uri, doc.name), {
                keys: table.keys,
                builderVersion: RESULT_CACHE_BUILDER_VERSION,
                ocpVersion: RESULT_CACHE_OCP_UNKNOWN,
                schemaVersion: doc.version,
                tessText: content.value.toString()
            });
        } catch (error) {
            console.warn('[CadViewport] Result-cache store skipped:', error);
        }
    }

    private async doEnterSketch(
        kind: DatumKind,
        offset: number,
        reference?: TopologyRef,
        extra?: { points?: readonly CurvePoint[]; faces?: TopologyRef[] }
    ): Promise<void> {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return;
        }
        const existingSketch = this.editingSketchId !== undefined ? doc.sketches.find((s) => s.id === this.editingSketchId) : undefined;
        let datumId: string | undefined;
        if (existingSketch !== undefined) {
            datumId = existingSketch.datumId;
        } else {
            // New sketch: find or create a datum matching the picker choice.
            const builtInId = kind !== 'face' ? this.datumIdForKind(kind) : undefined;
            if (kind !== 'face' && offset === 0 && builtInId !== undefined) {
                datumId = builtInId;
            } else {
                const datumResult = this.documentStore.addDatum(kind, offset, reference, extra);
                if (!datumResult.success) {
                    this.showBuildError(datumResult.error || 'Failed to create datum.');
                    this.messageService.error(datumResult.error || 'Failed to create datum.');
                    this.sketchSetupVisible = false;
                    this.sketchEntering = false;
                    this.facePickMode = undefined;
                    this.update();
                    return;
                }
                datumId = datumResult.value;
            }
        }
        if (datumId === undefined) {
            this.showBuildError(`Could not resolve datum for ${kind} offset ${offset}`);
            this.messageService.error(`Could not resolve datum for ${kind} offset ${offset}`);
            this.sketchEntering = false;
            this.sketchSetupVisible = false;
            this.facePickMode = undefined;
            this.update();
            return;
        }
        const sketchDef: SketchDef | undefined =
            existingSketch !== undefined
                ? { ...existingSketch, primitives: [...existingSketch.primitives], constraints: [...existingSketch.constraints] }
                : {
                      id: createSketchId(),
                      name: `Sketch ${doc.sketches.length + 1}`,
                      datumId,
                      primitives: [],
                      constraints: [],
                      dimensions: []
                  };
        if (existingSketch === undefined) {
            // Pre-register the new sketch so it can be referenced by features
            // even before the user exits sketch mode.
            const result = this.documentStore.upsertSketch(sketchDef);
            if (!result.success) {
                this.showBuildError(result.error || 'Failed to register new sketch.');
                this.sketchEntering = false;
                this.messageService.error(result.error || 'Failed to register new sketch.');
                this.sketchSetupVisible = false;
                this.facePickMode = undefined;
                this.update();
                return;
            }
        }
        this.editingSketchId = sketchDef.id;
        const inheritedParameters = { ...doc.parameters };
        try {
            await this.sketchController?.enterSketch(
                kind,
                offset,
                this.sketchCamera,
                // Always restore from the def (even for brand-new sketches): the
                // session must round-trip the pre-registered id and datumId, or
                // the exit-time upsert fails validation and traps the user in
                // sketch mode.
                sketchDef,
                inheritedParameters,
                reference
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.showBuildError(`Failed to start sketch solver: ${message}`);
            this.messageService.error(`Failed to start sketch solver: ${message}`);
            this.sketchSetupVisible = false;
            this.sketchEntering = false;
            this.facePickMode = undefined;
            this.editingSketchId = undefined;
            this.update();
        } finally {
            if (this.sketchEntering) {
                this.sketchEntering = false;
                this.update();
            }
        }
    }

    private datumIdForKind(kind: DatumKind): string | undefined {
        const map: Record<string, string> = { XY: 'datum-xy', YZ: 'datum-yz', XZ: 'datum-xz' };
        return map[kind];
    }

    private async doExitSketch(): Promise<void> {
        const session = this.sketchController?.getSession();
        if (session === undefined) {
            this.sketchSetupVisible = false;
            this.update();
            return;
        }
        const def = session.toSketchDef();
        const result = this.documentStore.upsertSketch(def);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to save sketch to document.');
            // Stay in sketch mode so the user can fix the issue.
            return;
        }
        this.editingSketchId = undefined;
        await this.sketchController?.exitSketch();
        this.sketchSetupVisible = false;
        this.facePickMode = undefined;
        const doc = this.documentStore.document;
        this.scheduleDocumentRebuild(doc !== undefined ? featuresConsumingSketch(doc, def.id) : undefined);
    }

    private scheduleDocumentRebuild(dirtyIds?: readonly string[]): void {
        if (!this.documentStore.hasDocument) {
            return;
        }
        // Every edit feeds the dirty plan; unknown scope conservatively marks
        // the whole tree (the next rebuild then takes the full path).
        const doc = this.documentStore.document;
        this.rebuildTracker.noteEdit(dirtyIds ?? (doc !== undefined ? allFeatureIds(doc) : []));
        if (this.preferences['nukeCad.rebuildOnEdit'] === 'manual') {
            // Manual mode never starts a timer or rebuild from an edit; the
            // stale banner offers the on-demand rebuild instead.
            this.buildStale = true;
            this.update();
            return;
        }
        if (this.rebuildPromise !== undefined) {
            this.rebuildPending = true;
            return;
        }
        this.clearSaveRebuildTimer();
        this.saveRebuildTimer = setTimeout(() => {
            this.saveRebuildTimer = undefined;
            void this.commandService.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id);
        }, 500);
    }

    private onDocumentChange(): void {
        const doc = this.documentStore.document;
        if (doc !== undefined && this.documentStore.uri === undefined) {
            // Untitled document: update the widget title but do not rebuild automatically.
            this.title.label = `CAD Viewport · ${doc.name}`;
            this.update();
            return;
        }
        // A saved/opened document or no document at all resets the untitled marker.
        if (this.title.label !== CadViewportWidget.LABEL) {
            this.title.label = CadViewportWidget.LABEL;
        }
        this.update();
    }

    /** Show a loading indicator over the current geometry while a rebuild runs. */
    setLoading(loading: boolean, message = 'Rebuilding CAD geometry...'): void {
        if (loading) {
            // Invalidate any in-flight tessellation load; a rebuild supersedes it.
            this.tessLoadToken++;
            this.tessLoadInFlight = false;
            this.loadingMessage = message;
            this.buildError = undefined;
            this.buildWarnings = [];
        }
        // Callers clear their own spinner when the build resolves, but the
        // viewport stays in the loading state until the requested
        // tessellation is parsed and on screen.
        this.loading = loading || this.tessLoadInFlight;
        this.update();
    }

    /** Surface a build failure as a dismissible banner inside the viewport. */
    showBuildError(message: string): void {
        this.tessLoadInFlight = false;
        this.loading = false;
        this.buildError = message;
        this.update();
    }

    /**
     * Forget which tessellation is on screen so the next model change reloads
     * it. The backend rewrites `<stem>.tess.json` at the same path on every
     * build, so path equality alone cannot detect a rebuild. `tessData` stays
     * untouched: the previous model remains visible during the build.
     */
    private invalidateTessellation(): void {
        this.loadedTessPath = undefined;
    }

    private handleModelChange(model: CadModel | undefined): void {
        const tessPath = model?.result.tessPath;
        const token = ++this.tessLoadToken;
        this.tessLoadInFlight = false;
        if (!tessPath) {
            this.tessData = undefined;
            this.loadedTessPath = undefined;
            this.loading = false;
            this.stateManager.setSolidSummaries([]);
            this.update();
            return;
        }
        if (tessPath === this.loadedTessPath && this.tessData !== undefined) {
            // Same tessellation already on screen; avoid a loading flash.
            this.loading = false;
            this.update();
            return;
        }
        // Keep the previous geometry on screen (with a loading indicator) until
        // the new tessellation arrives to avoid flashing the empty state.
        this.loading = true;
        this.loadingMessage = 'Loading CAD model...';
        this.buildError = undefined;
        this.stateManager.setSolidSummaries([]);
        this.update();
        this.tessLoadInFlight = true;
        this.loadTessellation(tessPath, token).catch((err) => {
            console.error('[CadViewport] Failed to load tessellation:', err);
            if (token === this.tessLoadToken) {
                this.tessLoadInFlight = false;
                this.loading = false;
                this.buildError = err instanceof Error ? err.message : String(err);
                this.update();
            }
        });
    }

    private async loadTessellation(path: string, token: number): Promise<void> {
        const t0 = PROFILE_TESSELLATION_LOAD ? performance.now() : 0;
        const content = await this.fileService.readFile(new URI(path));
        const tRead = PROFILE_TESSELLATION_LOAD ? performance.now() : 0;
        if (token !== this.tessLoadToken) {
            return; // A newer model or rebuild superseded this load.
        }
        this.tessData = await parseTessellationAsync(content.value.toString());
        if (token !== this.tessLoadToken) {
            return; // A newer model or rebuild superseded this parse.
        }
        if (PROFILE_TESSELLATION_LOAD) {
            const tParse = performance.now();
            console.log(
                `[CadViewport] profile: read ${(tRead - t0).toFixed(0)} ms, parse ${(tParse - tRead).toFixed(0)} ms, ${(content.value.toString().length / 1e6).toFixed(1)} MB`
            );
        }
        this.loadedTessPath = path;
        this.stateManager.setSolidSummaries(buildSolidSummaries(this.tessData.solids));
        this.tessLoadInFlight = false;
        this.loading = false;
        this.update();
    }

    /** Debounce saves of the active script-source model into a geometry rebuild. */
    private onModelScriptSaved(document: MonacoEditorModel): void {
        const scriptPath = this.stateManager.scriptPath;
        if (!scriptPath) {
            return;
        }
        if (scriptPath.toLowerCase().endsWith('.nuke-cad')) {
            // Document-mode models are not text-edited; rebuild is triggered
            // explicitly or after sketch/feature mutations.
            return;
        }
        if (!scriptPath.toLowerCase().endsWith('.py')) {
            return; // Only script-source models rebuild on save (STEP imports are read-only).
        }
        if (new URI(document.uri).path.toString() !== scriptPath) {
            return;
        }
        this.clearSaveRebuildTimer();
        this.saveRebuildTimer = setTimeout(() => {
            this.saveRebuildTimer = undefined;
            this.commandService.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch((err) => {
                console.error('[CadViewport] Save-triggered rebuild failed:', err);
            });
        }, 500);
    }

    private clearSaveRebuildTimer(): void {
        if (this.saveRebuildTimer !== undefined) {
            clearTimeout(this.saveRebuildTimer);
            this.saveRebuildTimer = undefined;
        }
    }

    /**
     * Open a `.nuke-cad` document by URI (public entry point for the open handler).
     *
     * Delegates to the document load path, which reloads the tessellation
     * after the build.
     */
    public async openModel(uri: URI): Promise<void> {
        await this.openDocumentModel(uri, uri.path.toString());
    }

    /**
     * Open a CAD model script, STEP file, or `.nuke-cad` document chosen from
     * the Open dialog.
     */
    protected async openModelFromDialog(): Promise<void> {
        const uri = await this.fileDialogService.showOpenDialog({
            title: 'Open CAD Model',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'CAD Models': ['py', 'step', 'stp', 'nuke-cad']
            }
        });
        if (!uri) {
            return;
        }

        const filePath = uri.path.toString();
        const ext = uri.path.ext.toLowerCase();

        if (ext === '.nuke-cad') {
            await this.openDocumentModel(uri, filePath);
            return;
        }

        const sourceType: 'script' | 'step' = ext === '.py' ? 'script' : 'step';

        this.setLoading(true, sourceType === 'step' ? 'Importing STEP file...' : 'Building CAD geometry...');

        this.messageService.info(`Loading CAD model: ${filePath}`);
        try {
            const result: GeometryBuildResult = await this.backendService.buildGeometry({
                scriptPath: filePath,
                sourceType,
                exportDagmc: sourceType === 'script' ? undefined : false,
                exportMesh: sourceType === 'script' ? undefined : false
            });
            if (result.success) {
                this.stateManager.setModel({
                    scriptPath: filePath,
                    result,
                    manifest: result.regionManifest
                });
                this.buildWarnings = result.warnings ?? [];
                this.messageService.info(`Loaded ${result.solidCount ?? 0} solids, ${result.triangleCount ?? 0} triangles`);
            } else {
                const message = result.error || 'Failed to load CAD model.';
                this.buildError = message;
                this.messageService.error(message);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.buildError = message;
            this.messageService.error(message);
        } finally {
            this.setLoading(false);
        }
    }

    private async openDocumentModel(uri: URI, filePath: string): Promise<void> {
        this.setLoading(true, 'Loading CAD document...');
        try {
            const content = await this.fileService.read(uri);
            const json = JSON.parse(content.value.toString()) as unknown;
            const result = this.documentStore.loadDocument(json);
            if (!result.success) {
                this.buildError = result.error || 'Failed to load .nuke-cad document.';
                this.messageService.error(this.buildError);
                return;
            }
            this.documentStore.setUri(uri.toString());
            this.documentStore.markSaved();
            // Opening a document always builds, in both rebuild modes.
            this.buildStale = false;
            this.rebuildTracker.reset();
            // A fresh open must not trust any tessellation left on screen:
            // the build rewrites the same `<stem>.tess.json` path.
            this.invalidateTessellation();
            const doc = this.documentStore.document;
            if (doc !== undefined && (await this.tryOpenFastPath(uri, filePath, doc))) {
                return;
            }
            await this.rebuildDocument(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.buildError = message;
            this.messageService.error(message);
        } finally {
            this.setLoading(false);
        }
    }

    /**
     * Open fast path: hash-check the document against the in-session memory
     * cache purely from the doc JSON (no OCP, no backend call). Full hit →
     * render the cached tessellation immediately with zero backend spawn;
     * miss → false and the caller restores from the zip sidecar (per-feature
     * fallback to execution), which populates the sidecar on the way.
     */
    private async tryOpenFastPath(uri: URI, filePath: string, doc: NukeCadDocument): Promise<boolean> {
        const cached = this.resultCache.get(cacheKeyForDocument(uri.toString(), doc.name));
        const check = checkOpenFastPath(doc, cached);
        if (!check.hit || cached === undefined) {
            return false;
        }
        try {
            // Publish a model without a tessellation path first (clears prior
            // state synchronously), then render the cached tessellation
            // directly — the backend never runs on this path.
            this.stateManager.setModel({ scriptPath: filePath, result: { success: true, scriptPath: filePath }, manifest: undefined });
            this.tessData = await parseTessellationAsync(cached.tessText);
            this.loadedTessPath = undefined;
            this.stateManager.setSolidSummaries(buildSolidSummaries(this.tessData.solids));
            this.tessLoadInFlight = false;
            this.loading = false;
            this.buildError = undefined;
            this.messageService.info(
                `CAD fast open: rendered cached tessellation (${this.tessData.solids.length} solids, zero backend spawn)`
            );
            this.update();
            return true;
        } catch (error) {
            console.warn('[CadViewport] Cached tessellation parse failed, falling back to full build:', error);
            return false;
        }
    }

    /** Closing the viewport also closes its companion panels (stale without a model). */
    protected override onCloseRequest(msg: Message): void {
        super.onCloseRequest(msg);
        for (const id of ['nuke-cad-outline-panel-widget', 'nuke-cad-feature-tree-widget']) {
            this.widgetManager.getWidgets(id).forEach((w) => w.close());
        }
    }

    protected render(): React.ReactNode {
        return (
            <CadViewportComponent
                loading={this.loading}
                loadingMessage={this.loadingMessage}
                tessData={this.tessData}
                error={this.buildError}
                warnings={this.buildWarnings}
                dirty={this.documentStore.dirty}
                sketchSetupVisible={this.sketchSetupVisible}
                sketchEditing={this.editingSketchId !== undefined}
                sketchEntering={this.sketchEntering}
                featureCreationType={this.featureCreationType}
                featureCreationBodyId={this.featureCreationBodyId}
                editingFeatureId={this.editingFeatureId}
                facePickMode={this.facePickMode}
                dressUpPickMode={this.dressUpPickMode}
                selectedCurveId={this.documentStore.selection.selectedCurveId}
                documentStore={this.documentStore}
                templatePickerOpen={this.templatePickerOpen}
                sketchAutoDimension={this.preferences['nukeCad.sketchAutoDimension']}
                ribbonLabels={this.preferences['nukeCad.ribbonLabels']}
                ribbonPins={this.preferences['nukeCad.ribbonPins'] ?? []}
                onToggleRibbonPin={this.handleToggleRibbonPin}
                viewportBackground={this.preferences['nukeCad.viewportBackground'] as ViewportBackgroundStyle}
                navigationStyle={this.preferences['nukeCad.navigationStyle'] as NavigationStyle}
                colorByMaterial={this.preferences['nukeCad.colorByMaterial']}
                lengthDecimals={this.preferences['nukeCad.lengthDecimals']}
                angleDecimals={this.preferences['nukeCad.angleDecimals']}
                showOriginAxes={this.preferences['nukeCad.showOriginAxes']}
                showOriginX={this.preferences['nukeCad.showOriginX']}
                showOriginY={this.preferences['nukeCad.showOriginY']}
                showOriginZ={this.preferences['nukeCad.showOriginZ']}
                rebuildOnEdit={this.preferences['nukeCad.rebuildOnEdit']}
                buildStale={this.buildStale}
                templates={DOCUMENT_TEMPLATES}
                onDismissError={this.dismissBuildError}
                onDismissWarnings={this.dismissBuildWarnings}
                onSelect={this.handleViewportSelect}
                subscribeSelection={this.subscribeSelection}
                subscribeHiddenSolids={this.subscribeHiddenSolids}
                subscribeThemeChange={this.subscribeThemeChange}
                onOpenModel={() => this.openModelFromDialog()}
                onNewDocument={this.handleNewDocument}
                onCreateDocument={this.handleCreateDocument}
                onCancelTemplatePicker={this.handleCancelTemplatePicker}
                onSaveDocument={this.handleSaveDocument}
                onRebuildDocument={this.handleRebuildDocument}
                onControllerReady={this.handleControllerReady}
                onCameraApiReady={this.handleCameraApiReady}
                onStartSketchSetup={this.startSketchSetup}
                onEnterSketch={this.handleEnterSketch}
                onEnterSketchDraft={this.handleEnterSketchDraft}
                onExitSketch={this.handleExitSketch}
                onToggleSketchMode={this.handleToggleSketchMode}
                onStartFeatureCreation={(type) => this.startFeatureCreation(type)}
                onAddFeature={this.handleAddFeature}
                onEditFeature={this.handleEditFeature}
                onEditSketch={this.handleEditSketch}
                onExportPython={() => void this.exportPython()}
                onCancelFeatureCreation={this.handleCancelFeatureCreation}
                onStartFacePick={this.handleStartFacePick}
                onStartExternalGeometryPick={this.handleStartExternalGeometryPick}
                onFacePick={this.handleFacePick}
                onFacePickCancel={this.handleFacePickCancel}
                onStartDressUpPick={this.handleStartDressUpPick}
                onDressUpPickCancel={this.handleDressUpPickCancel}
                onEdgePick={this.handleEdgePick}
                onFacePickDressUp={this.handleFacePickDressUp}
                onStartHolePick={this.handleStartHolePick}
                onHolePick={this.handleHolePick}
                onHolePickCancel={this.handleHolePickCancel}
                holePickMode={this.holePickMode !== undefined}
                onStartCurvePick={this.handleStartCurvePick}
                onCurvePick={this.handleCurvePick}
                onCurvePickCancel={this.handleCurvePickCancel}
                curvePickMode={this.curvePickMode !== undefined}
                onDrawingDimensionEdgePick={this.handleDrawingDimensionEdgePick}
                onDrawingDimensionEdgePickCancel={this.handleDrawingDimensionEdgePickCancel}
                drawingDimensionPickMode={this.drawingDimensionPickMode}
                connectorPickMode={this.connectorPickMode?.side}
                onStartConnectorPick={this.handleStartConnectorPick}
                onConnectorPickCancel={this.handleConnectorPickCancel}
                onConnectorPick={this.handleConnectorPick}
                mateDialogOpen={this.mateDialogOpen}
                mateConnectorA={this.mateConnectorA}
                mateConnectorB={this.mateConnectorB}
                matePreviewEnabled={this.matePreviewEnabled}
                onOpenMateDialog={this.handleOpenMateDialog}
                onCloseMateDialog={this.handleCloseMateDialog}
                onMateSubmit={this.handleMateSubmit}
                onMatePreviewChange={this.handleMatePreviewChange}
                onAddInstance={this.handleAddInstance}
                onGroundInstance={this.handleGroundInstance}
                onDeleteInstance={this.handleDeleteInstance}
                onRenameInstance={this.handleRenameInstance}
                onSelectInstance={this.handleSelectInstance}
                previewTessData={this.previewTessData}
                onPreviewChange={this.handleFeaturePreviewChange}
                sectionActive={this.sectionActive}
                onSetSectionActive={this.handleSetSectionActive}
                onExitSection={this.handleExitSection}
                onEditFeatureRequest={this.handleEditFeatureRequest}
                onHideSolid={this.handleHideSolid}
                onIsolateSolid={this.handleIsolateSolid}
                onHideSolids={this.handleHideSolids}
                onIsolateSolids={this.handleIsolateSolids}
                onShowAllSolids={this.handleShowAllSolids}
                onClearSelection={this.handleClearSelection}
                onRevealFeature={this.handleRevealFeature}
                appearanceTarget={this.appearanceTarget}
                appearancePresets={this.appearancePresets()}
                appearanceSelectionBodyIds={this.appearanceSelectionBodyIds}
                onOpenAppearance={this.handleOpenAppearance}
                onCloseAppearance={this.handleCloseAppearance}
                onApplyAppearance={this.handleApplyAppearance}
                onApplyAppearanceToBodies={this.handleApplyAppearanceToBodies}
                onRemoveAppearance={this.handleRemoveAppearance}
                onRemoveAppearanceFromBodies={this.handleRemoveAppearanceFromBodies}
                onSaveAppearancePreset={this.handleSaveAppearancePreset}
                onDeleteAppearancePreset={this.handleDeleteAppearancePreset}
                messageService={this.messageService}
            />
        );
    }

    /** Context-menu Edit Feature: reopen the dialog for the attributed feature. */
    protected readonly handleEditFeatureRequest = (featureId: string): void => {
        this.startFeatureEdit(featureId);
    };
}

interface CadViewportComponentProps {
    readonly loading: boolean;
    readonly loadingMessage: string;
    readonly tessData?: TessData;
    readonly error?: string;
    readonly warnings: readonly string[];
    readonly dirty: boolean;
    readonly sketchSetupVisible: boolean;
    readonly sketchEditing: boolean;
    readonly sketchEntering: boolean;
    readonly featureCreationType?: FeatureType;
    readonly featureCreationBodyId?: string;
    readonly editingFeatureId?: string;
    readonly facePickMode?: 'sketchDatum' | 'externalGeometry';
    readonly dressUpPickMode?: DressUpPickMode;
    readonly holePickMode?: boolean;
    readonly selectedCurveId?: string;
    readonly sectionActive: boolean;
    readonly documentStore: CadDocumentStore;
    readonly messageService: MessageService;
    readonly templatePickerOpen: boolean;
    readonly sketchAutoDimension: boolean;
    /** Show text under ribbon action icons; false renders compact icon buttons. */
    readonly ribbonLabels: boolean;
    /** Command ids pinned inline in their ribbon section. */
    readonly ribbonPins: readonly string[];
    /** Toggle a command's inline pin state. */
    readonly onToggleRibbonPin: (commandId: string) => void;
    readonly viewportBackground: ViewportBackgroundStyle;
    readonly navigationStyle: NavigationStyle;
    /** Color bodies from their material tags (explicit appearance colors still win). */
    readonly colorByMaterial: boolean;
    /** Maximum decimal places for length readouts (measure labels + popover rows). */
    readonly lengthDecimals: number;
    /** Maximum decimal places for angle readouts (measure labels + popover rows). */
    readonly angleDecimals: number;
    /** World-origin triad and per-axis visibility preferences (display-only). */
    readonly showOriginAxes: boolean;
    readonly showOriginX: boolean;
    readonly showOriginY: boolean;
    readonly showOriginZ: boolean;
    readonly rebuildOnEdit: 'auto' | 'manual';
    readonly buildStale: boolean;
    readonly templates: ReadonlyArray<import('../../../common/document-templates').DocumentTemplate>;
    readonly onDismissError: () => void;
    readonly onDismissWarnings: () => void;
    readonly onSelect: (selection: CadSelection) => void;
    readonly subscribeSelection: (listener: (selection: CadSelection) => void) => Disposable;
    readonly subscribeHiddenSolids: (listener: (ids: readonly number[]) => void) => Disposable;
    readonly subscribeThemeChange: (listener: () => void) => Disposable;
    readonly onOpenModel: () => void;
    readonly onNewDocument: () => void;
    readonly onCreateDocument: (templateId: string) => void;
    readonly onCancelTemplatePicker: () => void;
    readonly onSaveDocument: () => void;
    readonly onRebuildDocument: () => void;
    readonly onControllerReady: (controller: SketchModeController, camera: THREE.PerspectiveCamera) => void;
    /** Publish/clear camera access for named-view capture and restore. */
    readonly onCameraApiReady: (api: CadCameraApi | undefined) => void;
    readonly onStartSketchSetup: () => void;
    readonly onEnterSketch: (kind: DatumKind, offset: number) => void;
    readonly onEnterSketchDraft: (draft: DatumDraft, offset: number) => void;
    readonly onExitSketch: () => Promise<void>;
    readonly onToggleSketchMode: () => void;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
    readonly onAddFeature: (type: FeatureType, params: FeatureParams) => void;
    readonly onEditFeature: (id: string, params: FeatureParams) => void;
    readonly onEditSketch: (sketchId: string) => void;
    readonly onExportPython: () => void;
    readonly onCancelFeatureCreation: () => void;
    readonly onStartFacePick: (offset: number) => void;
    readonly onStartExternalGeometryPick: (featureId: string) => void;
    readonly onFacePick: (hit: FacePickHit) => void;
    readonly onFacePickCancel: () => void;
    readonly onStartDressUpPick: (
        type: FeatureType,
        selecting: 'edge' | 'face',
        callback: (ref: TopologyRef) => void,
        tangentChain?: boolean
    ) => void;
    readonly onDressUpPickCancel: () => void;
    readonly onEdgePick: (hit: EdgePickHit, edgeLines?: readonly THREE.Line[]) => void;
    readonly onFacePickDressUp: (hit: FacePickHit) => void;
    readonly onStartHolePick: (callback: (ref: TopologyRef, uv: [number, number]) => void) => void;
    readonly onHolePick: (hit: FacePickHit) => void;
    readonly onHolePickCancel: () => void;
    readonly onStartCurvePick: (callback: (curveId: string) => void) => void;
    readonly onCurvePick: (curveId: string) => void;
    readonly onCurvePickCancel: () => void;
    readonly curvePickMode?: boolean;
    /** Drawing-dimension edge pick: viewport clicks feed the Drawing Sheet dimension tool. */
    readonly onDrawingDimensionEdgePick: (hit: EdgePickHit) => void;
    readonly onDrawingDimensionEdgePickCancel: () => void;
    readonly drawingDimensionPickMode?: { readonly kind: DrawingDimensionPickRequest['kind']; readonly picked: number };
    /** Mate-dialog connector pick: which side the next viewport click feeds. */
    readonly connectorPickMode?: 'A' | 'B';
    readonly onStartConnectorPick: (side: 'A' | 'B') => void;
    readonly onConnectorPickCancel: () => void;
    readonly onConnectorPick: (connectorId: string) => void;
    readonly mateDialogOpen: boolean;
    readonly mateConnectorA?: string;
    readonly mateConnectorB?: string;
    readonly matePreviewEnabled: boolean;
    readonly onOpenMateDialog: () => void;
    readonly onCloseMateDialog: () => void;
    readonly onMateSubmit: (draft: MateDraft) => void;
    readonly onMatePreviewChange: (enabled: boolean) => void;
    readonly onAddInstance: (part: string) => void;
    readonly onGroundInstance: (instanceId: string) => void;
    readonly onDeleteInstance: (instanceId: string) => void;
    readonly onRenameInstance: (instanceId: string, newId: string) => void;
    readonly onSelectInstance: (instanceId: string) => void;
    readonly previewTessData?: TessData;
    readonly onPreviewChange: (request: FeaturePreviewRequest | undefined) => void;
    readonly onSetSectionActive: (active: boolean) => void;
    readonly onExitSection: () => void;
    /** Viewport context menu: open the feature dialog for an attributed feature. */
    readonly onEditFeatureRequest: (featureId: string) => void;
    /** Viewport context menu: hide/isolate/reveal solids via the state manager. */
    readonly onHideSolid: (solidId: number) => void;
    readonly onIsolateSolid: (solidId: number) => void;
    readonly onHideSolids: (solidIds: readonly number[]) => void;
    readonly onIsolateSolids: (solidIds: readonly number[]) => void;
    readonly onShowAllSolids: () => void;
    /** Viewport context menu/Escape: clear the document and viewport selection. */
    readonly onClearSelection: () => void;
    /** Viewport context menu: select a feature and reveal the Feature Tree. */
    readonly onRevealFeature: (featureId: string) => void;
    /** Per-body Appearance dialog target; undefined when the dialog is closed. */
    readonly appearanceTarget?: BodyAppearanceTarget;
    /** Normalized user appearance presets (preference-scoped). */
    readonly appearancePresets: readonly AppearancePreset[];
    /** Distinct body ids owning the viewport selection when the dialog opened. */
    readonly appearanceSelectionBodyIds: readonly string[];
    /** Viewport context menu Appearance…: open the dialog for a body. */
    readonly onOpenAppearance: (bodyId: string) => void;
    readonly onCloseAppearance: () => void;
    readonly onApplyAppearance: (bodyId: string, appearance: BodyAppearance) => void;
    readonly onApplyAppearanceToBodies: (bodyIds: readonly string[], appearance: BodyAppearance) => void;
    readonly onRemoveAppearance: (bodyId: string) => void;
    readonly onRemoveAppearanceFromBodies: (bodyIds: readonly string[]) => void;
    readonly onSaveAppearancePreset: (appearance: BodyAppearance) => Promise<string | undefined>;
    readonly onDeleteAppearancePreset: (name: string) => Promise<void>;
}

function CadViewportComponent(props: CadViewportComponentProps): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [controller, setController] = React.useState<SketchModeController | undefined>();
    const [shadingMode, setShadingMode] = React.useState<ShadingMode>('shaded');
    const [ghostOpacity, setGhostOpacity] = React.useState(DEFAULT_GHOST_OPACITY);
    /** Single bottom-bar popover: the shading and section cards share one anchor slot. */
    const [openPopover, setOpenPopover] = React.useState<'shading' | 'section' | undefined>(undefined);
    const [sectionAxis, setSectionAxis] = React.useState<SectionAxis>('z');
    const [sectionFlip, setSectionFlip] = React.useState(false);
    const [sectionFraction, setSectionFraction] = React.useState(DEFAULT_SECTION_FRACTION);
    const [warningsOpen, setWarningsOpen] = React.useState(false);
    const warningStripRef = React.useRef<HTMLDivElement>(null);
    const [measureActive, setMeasureActive] = React.useState(false);
    const [measureTool, setMeasureTool] = React.useState<MeasureToolMode>('distance');
    const [measurements, setMeasurements] = React.useState<Measurement[]>([]);
    const [measurePending, setMeasurePending] = React.useState<MeasurePoint3D | undefined>();
    const [measureVertex, setMeasureVertex] = React.useState<MeasurePoint3D | undefined>();
    const [measureListOpen, setMeasureListOpen] = React.useState(false);
    const [explodeFactor, setExplodeFactor] = React.useState(0);
    const [shortcutBar, setShortcutBar] = React.useState<
        { readonly mode: 'document' | 'sketch'; readonly anchor: { readonly x: number; readonly y: number } } | undefined
    >(undefined);
    const measurePendingRef = React.useRef<MeasurePoint3D | undefined>(undefined);
    const measureVertexRef = React.useRef<MeasurePoint3D | undefined>(undefined);
    const prevMeasureSketchRef = React.useRef(false);
    /** Read at pin time without becoming a dependency of the pin handler. */
    const measurementsRef = React.useRef<Measurement[]>([]);
    measurementsRef.current = measurements;
    /** Read at menu-dispatch time so initViewport never depends on render props. */
    const sectionActiveRef = React.useRef(props.sectionActive);
    sectionActiveRef.current = props.sectionActive;
    const handleClosePopover = React.useCallback((): void => setOpenPopover(undefined), []);
    /** Section toggle (nav button and context menu): chrome and popover stay in sync. */
    const handleToggleSection = React.useCallback((): void => {
        const next = !sectionActiveRef.current;
        props.onSetSectionActive(next);
        setOpenPopover(next ? 'section' : undefined);
    }, [props.onSetSectionActive]);
    const editFeature = React.useMemo(() => {
        if (props.editingFeatureId === undefined) {
            return undefined;
        }
        return props.documentStore.document?.features.find((f) => f.id === props.editingFeatureId);
    }, [props.editingFeatureId, props.documentStore.document?.features]);
    const closeShortcutBar = React.useCallback((): void => setShortcutBar(undefined), []);
    const navRef = React.useRef<HTMLDivElement>(null);
    /**
     * Measured width of the bottom-right navigation cluster. The bottom-center
     * status pill caps its own width clear of it; without the measurement the
     * pill slides underneath the cluster on wide nav layouts (explode slider).
     */
    const [navWidth, setNavWidth] = React.useState(0);

    const viewportApi = React.useRef<{
        updateModel?: (tessData?: TessData) => void;
        updateSelectedCurve?: (curveId: string | undefined) => void;
        setFacePickMode?: (mode?: 'sketchDatum' | 'externalGeometry') => void;
        setDressUpPickMode?: (mode?: DressUpPickMode) => void;
        setHolePickMode?: (active: boolean) => void;
        setCurvePickMode?: (active: boolean) => void;
        setDrawingDimensionPickMode?: (active: boolean) => void;
        setConnectorPickMode?: (active: boolean) => void;
        setConnectorTriads?: (triads: readonly ConnectorTriad[]) => void;
        setPreviewTessellation?: (tessData?: TessData) => void;
        fitView?: () => void;
        zoomView?: (factor: number) => void;
        setStandardView?: (view: 'iso' | 'top' | 'front' | 'right') => void;
        snapView?: (direction: readonly [number, number, number]) => void;
        setShading?: (mode: ShadingMode) => void;
        setGhostOpacity?: (value: number) => void;
        setColorByMaterial?: (enabled: boolean) => void;
        setViewportBackground?: (style: ViewportBackgroundStyle) => void;
        setNavigationStyle?: (style: NavigationStyle) => void;
        setSection?: (section?: SectionState) => void;
        setExplodeFactor?: (factor: number) => void;
        setOriginAxes?: (axes: OriginAxesVisibility, suppressed?: boolean) => void;
        updateMeasureState?: (state: MeasureViewState) => void;
        setMeasurementDecimals?: (decimals: MeasurementDecimals) => void;
        setAutoDimensionEnabled?: (enabled: boolean) => void;
    }>({});

    /** Active standard view name for the shared badge (`User` after orbiting, `Top` after snapping). */
    const [viewName, setViewName] = React.useState('User');
    /** Shared orientation cube handle: the scene pushes camera quaternions imperatively (no React state). */
    const viewCubeRef = React.useRef<ViewCubeHandle | null>(null);
    /** Scene callback: a snap or orbit gesture renamed the view. */
    const handleViewNameChange = React.useCallback((name: string): void => {
        setViewName(name);
    }, []);
    /** Scene callback: mirror the camera orientation on the shared cube (direct DOM writes, no re-render). */
    const handleViewCubeUpdate = React.useCallback((quaternion: readonly [number, number, number, number]): void => {
        viewCubeRef.current?.update({ quaternion });
    }, []);
    /** Shared bottom-bar router: standard views, fit, and zoom on the viewport API. */
    const handleViewerNavAction = React.useCallback((action: ViewerNavAction): void => {
        if (action === 'fit') {
            viewportApi.current.fitView?.();
            return;
        }
        if (action === 'zoom-in') {
            viewportApi.current.zoomView?.(0.8);
            return;
        }
        if (action === 'zoom-out') {
            viewportApi.current.zoomView?.(1.25);
            return;
        }
        viewportApi.current.setStandardView?.(action);
    }, []);

    const measureMode: MeasureKind =
        (controller?.isActive ?? false) || props.sketchSetupVisible || props.sketchEntering ? 'sketch' : 'model3d';

    // Sketch mode has no angle/radius capture; the tool selector only applies
    // to the 3D surface.
    const activeMeasureTool: MeasureToolMode = measureMode === 'sketch' ? 'distance' : measureTool;

    const clearMeasurePendings = React.useCallback((): void => {
        measurePendingRef.current = undefined;
        measureVertexRef.current = undefined;
        setMeasurePending(undefined);
        setMeasureVertex(undefined);
    }, []);

    const handleMeasureDeactivate = React.useCallback((): void => {
        clearMeasurePendings();
        setMeasureActive(false);
        setMeasureListOpen(false);
    }, [clearMeasurePendings]);

    // Read at click time without becoming a dependency of handleMeasurePoint:
    // the capture mode decides which lifecycle bucket a segment lands in.
    const sketchModeRef = React.useRef<MeasureKind>('model3d');
    sketchModeRef.current = measureMode;
    const measureToolRef = React.useRef<MeasureToolMode>('distance');
    measureToolRef.current = activeMeasureTool;

    const handleMeasurePoint = React.useCallback(
        (point: MeasurePoint3D): void => {
            const tool = sketchModeRef.current === 'sketch' ? 'distance' : measureToolRef.current;
            if (tool === 'angle') {
                if (measurePendingRef.current === undefined) {
                    measurePendingRef.current = point;
                    setMeasurePending(point);
                    return;
                }
                if (measureVertexRef.current === undefined) {
                    measureVertexRef.current = point;
                    setMeasureVertex(point);
                    return;
                }
                const a = measurePendingRef.current;
                const b = measureVertexRef.current;
                clearMeasurePendings();
                // A degenerate (zero-length) leg yields NaN; never commit a bogus angle.
                if (Number.isFinite(measureAngle(a, b, point))) {
                    setMeasurements((prev) => [...prev, createMeasureAngle(nextMeasureId(), 'model3d', a, b, point)]);
                }
                return;
            }
            const pending = measurePendingRef.current;
            if (pending === undefined) {
                measurePendingRef.current = point;
                setMeasurePending(point);
                return;
            }
            clearMeasurePendings();
            const segment = createMeasureSegment(nextMeasureId(), sketchModeRef.current, pending, point);
            setMeasurements((prev) => [...prev, segment]);
        },
        [clearMeasurePendings]
    );

    const handleMeasureRadius = React.useCallback((center: MeasurePoint3D, radius: number): void => {
        setMeasurements((prev) => [...prev, createMeasureRadius(nextMeasureId(), center, radius)]);
    }, []);

    const handleMeasureToolChange = React.useCallback(
        (tool: MeasureToolMode): void => {
            clearMeasurePendings();
            setMeasureTool(tool);
        },
        [clearMeasurePendings]
    );

    const handleToggleMeasure = React.useCallback((): void => {
        measurePendingRef.current = undefined;
        setMeasurePending(undefined);
        setMeasureActive((prev) => !prev);
    }, []);

    /** Context-menu entry: activate the tool in the chosen mode. */
    const handleStartMeasureTool = React.useCallback(
        (tool: MeasureToolMode): void => {
            clearMeasurePendings();
            setMeasureTool(tool);
            setMeasureActive(true);
        },
        [clearMeasurePendings]
    );

    /** Context-menu entry: reassemble an exploded model. */
    const handleResetExplode = React.useCallback((): void => setExplodeFactor(0), []);

    const handleToggleMeasureList = React.useCallback((): void => {
        setMeasureListOpen((prev) => !prev);
    }, []);

    const handleMeasureDelete = React.useCallback(
        (id: string): void => {
            setMeasurements((prev) => prev.filter((segment) => segment.id !== id));
            // Deleting a pinned row unpins it too, or it would re-render on
            // the next rebuild. Unpinned ids simply miss in the store.
            props.documentStore.removeMeasurement(id);
        },
        [props.documentStore]
    );

    const handleMeasureClear = React.useCallback((): void => {
        setMeasurements([]);
        // Clear All removes the saved block entries as well, or pinned rows
        // would re-render on the next rebuild.
        for (const saved of props.documentStore.document?.measurements ?? []) {
            props.documentStore.removeMeasurement(saved.id);
        }
    }, [props.documentStore]);

    /**
     * Pin a viewport measurement into the document's `measurements` block.
     *
     * Only `model3d` entries are pinnable (sketch entries die with the
     * session). The store mints the saved id and the ephemeral copy is
     * retagged to it, so pin state tracks by one id across rebuilds. Pinning
     * rides the normal commit path (undo-covered) but never schedules a
     * rebuild — measurements are annotations, never build inputs.
     */
    const handleMeasurePin = React.useCallback(
        (id: string): void => {
            const measurement = measurementsRef.current.find((entry) => entry.id === id);
            if (measurement === undefined || measurement.kind !== 'model3d') {
                return;
            }
            const draft = toSavedMeasurement(measurement);
            const points = draft.points.map((p) => [p[0], p[1], p[2]] as MeasurePoint3D);
            const result = props.documentStore.addMeasurement({ kind: draft.kind, points, label: draft.label });
            if (!result.success || result.value === undefined) {
                return;
            }
            const savedId = result.value;
            setMeasurements((prev) => prev.map((entry) => (entry.id === id ? retagMeasurement(entry, savedId) : entry)));
        },
        [props.documentStore]
    );

    /** Unpin a saved measurement; its ephemeral copy stays on screen, unpinned. */
    const handleMeasureUnpin = React.useCallback(
        (id: string): void => {
            props.documentStore.removeMeasurement(id);
        },
        [props.documentStore]
    );

    React.useEffect(() => {
        viewportApi.current.updateMeasureState?.({
            active: measureActive,
            mode: measureMode,
            tool: activeMeasureTool,
            measurements,
            pending: measurePending,
            pendingVertex: measureVertex
        });
    }, [measureActive, measureMode, activeMeasureTool, measurements, measurePending, measureVertex, controller]);

    React.useEffect(() => {
        if (shadingMode === 'edgesOnly') {
            handleMeasureDeactivate();
        }
    }, [shadingMode, handleMeasureDeactivate]);

    React.useEffect(() => {
        if (props.featureCreationType !== undefined) {
            handleMeasureDeactivate();
        }
    }, [props.featureCreationType, handleMeasureDeactivate]);

    React.useEffect(() => {
        const sketchNow = measureMode === 'sketch';
        if (sketchNow && !prevMeasureSketchRef.current) {
            handleMeasureDeactivate();
        }
        if (!sketchNow && prevMeasureSketchRef.current) {
            setMeasurements((prev) => prev.filter((segment) => segment.kind !== 'sketch'));
        }
        prevMeasureSketchRef.current = sketchNow;
    }, [measureMode, handleMeasureDeactivate]);

    React.useEffect(() => {
        // A rebuild replaces the tessellation: unpinned measurements
        // reference the old surface and are session state only, so they never
        // survive it. Pinned measurements restore from the document block and
        // re-render with their saved ids. The explode factor moves with the
        // same rebuild, so it resets too.
        clearMeasurePendings();
        setMeasurements(restoreSavedMeasurements(props.documentStore.document?.measurements));
        setExplodeFactor(0);
        // The document is read (not subscribed) here: a pin/unpin commit must
        // not re-run this effect, or it would wipe the unpinned session list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.tessData, clearMeasurePendings]);

    const modeMeasurements = measurements.filter((measurement) => measurement.kind === measureMode);

    React.useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return undefined;
        }

        let disposed = false;
        let cleanup: (() => void) | undefined;

        (async () => {
            const [{ OrbitControls }] = await Promise.all([import('three/examples/jsm/controls/OrbitControls.js')]);
            if (disposed) {
                return;
            }
            const api = initViewport(
                container,
                props.tessData,
                props.documentStore,
                props.onSelect,
                props.subscribeSelection,
                props.subscribeHiddenSolids,
                props.subscribeThemeChange,
                props.onControllerReady,
                props.onFacePick,
                props.onFacePickCancel,
                props.onEdgePick,
                props.onFacePickDressUp,
                props.onDressUpPickCancel,
                props.onStartHolePick,
                props.onHolePick,
                props.onHolePickCancel,
                props.holePickMode ?? false,
                props.onCurvePick,
                props.onCurvePickCancel,
                props.curvePickMode ?? false,
                props.onDrawingDimensionEdgePick,
                props.onDrawingDimensionEdgePickCancel,
                props.drawingDimensionPickMode !== undefined,
                props.onConnectorPick,
                props.onConnectorPickCancel,
                props.connectorPickMode !== undefined,
                props.messageService,
                props.onToggleSketchMode,
                props.onExitSketch,
                props.onExitSection,
                handleMeasurePoint,
                handleMeasureRadius,
                handleMeasureDeactivate,
                (mode, anchor) => setShortcutBar({ mode, anchor }),
                props.onEditFeatureRequest,
                handleStartMeasureTool,
                handleResetExplode,
                OrbitControls,
                props.viewportBackground,
                props.navigationStyle,
                props.colorByMaterial,
                { length: props.lengthDecimals, angle: props.angleDecimals },
                { enabled: props.showOriginAxes, x: props.showOriginX, y: props.showOriginY, z: props.showOriginZ },
                () => sectionActiveRef.current,
                handleClosePopover,
                handleToggleSection,
                props.onHideSolid,
                props.onIsolateSolid,
                props.onHideSolids,
                props.onIsolateSolids,
                props.onShowAllSolids,
                props.onClearSelection,
                props.onRevealFeature,
                props.onOpenAppearance,
                handleViewCubeUpdate,
                handleViewNameChange
            );
            if (disposed) {
                api.cleanup();
                return;
            }
            cleanup = api.cleanup;
            viewportApi.current.updateModel = api.updateModel;
            viewportApi.current.updateSelectedCurve = api.updateSelectedCurve;
            viewportApi.current.setFacePickMode = api.setFacePickMode;
            viewportApi.current.setDressUpPickMode = api.setDressUpPickMode;
            viewportApi.current.setHolePickMode = api.setHolePickMode;
            viewportApi.current.setCurvePickMode = api.setCurvePickMode;
            viewportApi.current.setDrawingDimensionPickMode = api.setDrawingDimensionPickMode;
            viewportApi.current.setConnectorPickMode = api.setConnectorPickMode;
            viewportApi.current.setConnectorTriads = api.setConnectorTriads;
            viewportApi.current.setPreviewTessellation = api.setPreviewTessellation;
            viewportApi.current.fitView = api.fitView;
            viewportApi.current.zoomView = api.zoomView;
            viewportApi.current.setStandardView = api.setStandardView;
            viewportApi.current.snapView = api.snapView;
            viewportApi.current.setShading = api.setShading;
            viewportApi.current.setGhostOpacity = api.setGhostOpacity;
            viewportApi.current.setColorByMaterial = api.setColorByMaterial;
            viewportApi.current.setViewportBackground = api.setViewportBackground;
            viewportApi.current.setNavigationStyle = api.setNavigationStyle;
            viewportApi.current.setSection = api.setSection;
            viewportApi.current.setExplodeFactor = api.setExplodeFactor;
            viewportApi.current.setOriginAxes = api.setOriginAxes;
            viewportApi.current.updateMeasureState = api.updateMeasureState;
            viewportApi.current.setMeasurementDecimals = api.setMeasurementDecimals;
            viewportApi.current.setAutoDimensionEnabled = api.setAutoDimensionEnabled;
            props.onCameraApiReady({ getCameraState: api.getCameraState, setCameraState: api.setCameraState });
            api.setFacePickMode(props.facePickMode);
            api.setDressUpPickMode(props.dressUpPickMode);
            api.setHolePickMode(props.holePickMode ?? false);
            api.setCurvePickMode(props.curvePickMode ?? false);
            api.setConnectorPickMode(props.connectorPickMode !== undefined);
            api.setPreviewTessellation(props.previewTessData);
            setController(api.controller);
        })().catch((err) => {
            console.error('[CadViewport] Failed to initialize viewport:', err);
        });

        return () => {
            disposed = true;
            viewportApi.current.updateModel = undefined;
            viewportApi.current.updateSelectedCurve = undefined;
            viewportApi.current.setFacePickMode = undefined;
            viewportApi.current.setDressUpPickMode = undefined;
            viewportApi.current.setHolePickMode = undefined;
            viewportApi.current.setCurvePickMode = undefined;
            viewportApi.current.setDrawingDimensionPickMode = undefined;
            viewportApi.current.setConnectorPickMode = undefined;
            viewportApi.current.setConnectorTriads = undefined;
            viewportApi.current.setPreviewTessellation = undefined;
            viewportApi.current.fitView = undefined;
            viewportApi.current.zoomView = undefined;
            viewportApi.current.setStandardView = undefined;
            viewportApi.current.snapView = undefined;
            viewportApi.current.setShading = undefined;
            viewportApi.current.setGhostOpacity = undefined;
            viewportApi.current.setColorByMaterial = undefined;
            viewportApi.current.setViewportBackground = undefined;
            viewportApi.current.setNavigationStyle = undefined;
            viewportApi.current.setSection = undefined;
            viewportApi.current.setExplodeFactor = undefined;
            viewportApi.current.setOriginAxes = undefined;
            viewportApi.current.updateMeasureState = undefined;
            viewportApi.current.setMeasurementDecimals = undefined;
            viewportApi.current.setAutoDimensionEnabled = undefined;
            props.onCameraApiReady(undefined);
            cleanup?.();
        };
        // All non-tessData props are stable widget-bound callbacks; the scene is
        // rebuilt only when a new tessellation arrives.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    React.useEffect(() => {
        viewportApi.current.updateModel?.(props.tessData);
    }, [props.tessData, controller]);

    React.useEffect(() => {
        viewportApi.current.setFacePickMode?.(props.facePickMode);
    }, [props.facePickMode]);

    React.useEffect(() => {
        viewportApi.current.setDressUpPickMode?.(props.dressUpPickMode);
    }, [props.dressUpPickMode]);

    React.useEffect(() => {
        viewportApi.current.setHolePickMode?.(props.holePickMode ?? false);
    }, [props.holePickMode]);

    React.useEffect(() => {
        viewportApi.current.setCurvePickMode?.(props.curvePickMode ?? false);
    }, [props.curvePickMode]);

    React.useEffect(() => {
        viewportApi.current.setDrawingDimensionPickMode?.(props.drawingDimensionPickMode !== undefined);
    }, [props.drawingDimensionPickMode]);

    React.useEffect(() => {
        viewportApi.current.setConnectorPickMode?.(props.connectorPickMode !== undefined);
    }, [props.connectorPickMode]);

    // Connector triads: every connector frame at its solved assembly pose.
    // Shown during connector-pick mode (hover triad highlight) and the
    // ghosted mate preview (both connectors at solved poses in `cad-preview`);
    // failures clear silently per the preview contract.
    React.useEffect(() => {
        if (props.connectorPickMode === undefined && !props.matePreviewEnabled) {
            viewportApi.current.setConnectorTriads?.([]);
            return;
        }
        try {
            const doc = props.documentStore.document;
            const assembly = doc !== undefined ? getAssemblySection(doc) : undefined;
            viewportApi.current.setConnectorTriads?.(assembly !== undefined ? assemblyConnectorTriads(assembly) : []);
        } catch {
            viewportApi.current.setConnectorTriads?.([]);
        }
    }, [
        props.connectorPickMode,
        props.matePreviewEnabled,
        props.mateDialogOpen,
        props.mateConnectorA,
        props.mateConnectorB,
        props.documentStore.document
    ]);

    React.useEffect(() => {
        viewportApi.current.setPreviewTessellation?.(props.previewTessData);
    }, [props.previewTessData, controller]);

    React.useEffect(() => {
        viewportApi.current.updateSelectedCurve?.(props.selectedCurveId);
    }, [props.selectedCurveId, controller]);

    React.useEffect(() => {
        viewportApi.current.setSection?.(
            props.sectionActive ? { axis: sectionAxis, flip: sectionFlip, fraction: sectionFraction } : undefined
        );
    }, [props.sectionActive, sectionAxis, sectionFlip, sectionFraction, controller]);

    React.useEffect(() => {
        viewportApi.current.setExplodeFactor?.(explodeFactor);
    }, [explodeFactor, controller]);

    React.useEffect(() => {
        viewportApi.current.setAutoDimensionEnabled?.(props.sketchAutoDimension);
    }, [props.sketchAutoDimension, controller]);

    React.useEffect(() => {
        viewportApi.current.setViewportBackground?.(props.viewportBackground);
    }, [props.viewportBackground, controller]);

    // Material coloring is purely a display preference: the body override map
    // re-derives in place, never rebuilding the scene.
    React.useEffect(() => {
        viewportApi.current.setColorByMaterial?.(props.colorByMaterial);
    }, [props.colorByMaterial, controller]);

    React.useEffect(() => {
        viewportApi.current.setNavigationStyle?.(props.navigationStyle);
    }, [props.navigationStyle, controller]);

    React.useEffect(() => {
        viewportApi.current.setMeasurementDecimals?.({ length: props.lengthDecimals, angle: props.angleDecimals });
    }, [props.lengthDecimals, props.angleDecimals, controller]);

    // Origin axes are display-only: preference changes update line visibility
    // in place, never re-initialize the scene. Sketch setup/entering suppresses
    // the whole group with the rest of the document chrome; an active sketch
    // session is hidden inside the scene itself, and the scene also hides the
    // group whenever no tessellation is loaded.
    React.useEffect(() => {
        viewportApi.current.setOriginAxes?.(
            { enabled: props.showOriginAxes, x: props.showOriginX, y: props.showOriginY, z: props.showOriginZ },
            props.sketchSetupVisible || props.sketchEntering
        );
    }, [
        props.showOriginAxes,
        props.showOriginX,
        props.showOriginY,
        props.showOriginZ,
        props.sketchSetupVisible,
        props.sketchEntering,
        controller
    ]);

    React.useEffect(() => {
        if (props.warnings.length > 0) {
            setWarningsOpen(false);
        }
    }, [props.warnings.length]);

    // The warning list is a transient popover: besides the toggle, a pointer
    // press anywhere outside the strip and Escape close it. Listeners exist
    // only while it is open and are removed on close/unmount.
    React.useEffect(() => {
        if (!warningsOpen) {
            return undefined;
        }
        const closeOnOutsidePointer = (event: PointerEvent): void => {
            const strip = warningStripRef.current;
            if (strip !== null && event.target instanceof Node && strip.contains(event.target)) {
                return;
            }
            setWarningsOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setWarningsOpen(false);
            }
        };
        window.addEventListener('pointerdown', closeOnOutsidePointer, true);
        window.addEventListener('keydown', closeOnEscape, true);
        return () => {
            window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
            window.removeEventListener('keydown', closeOnEscape, true);
        };
    }, [warningsOpen]);

    // All hooks must run on every render: the loading branch below returns
    // early, so nothing that calls a hook may sit after it.
    const sketchActive = (controller?.isActive ?? false) || props.sketchSetupVisible || props.sketchEntering;

    // Keep the status pill clear of the navigation cluster: re-measure the
    // cluster whenever it (re)mounts or resizes. The pill falls back to its
    // CSS `max-width` until the first measurement lands.
    React.useEffect(() => {
        const nav = navRef.current;
        if (nav === null) {
            return undefined;
        }
        const measure = (): void => setNavWidth(nav.offsetWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(nav);
        return () => observer.disconnect();
    }, [props.tessData, sketchActive, props.loading]);

    const errorBanner = props.error ? (
        <div className="cad-viewport-error-banner">
            <span className="codicon codicon-error" />
            <span className="cad-viewport-error-message">{props.error}</span>
            <Tooltip content="Dismiss" position="left">
                <button className="theia-button secondary cad-viewport-error-dismiss" onClick={props.onDismissError}>
                    <span className="codicon codicon-close" />
                </button>
            </Tooltip>
        </div>
    ) : undefined;

    const warningStrip =
        props.warnings.length > 0 ? (
            <div className="cad-viewport-warning-strip" ref={warningStripRef}>
                <div className="cad-viewport-warning-header">
                    <span className="codicon codicon-warning" />
                    <button
                        className="theia-button secondary cad-viewport-warning-toggle"
                        aria-expanded={warningsOpen}
                        onClick={() => setWarningsOpen(!warningsOpen)}
                    >
                        {`${props.warnings.length} build warning${props.warnings.length === 1 ? '' : 's'}`}
                        <span className={`codicon ${warningsOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
                    </button>
                    <Tooltip content="Dismiss" position="left">
                        <button className="theia-button secondary cad-viewport-error-dismiss" onClick={props.onDismissWarnings}>
                            <span className="codicon codicon-close" />
                        </button>
                    </Tooltip>
                </div>
                {warningsOpen && (
                    <div className="cad-viewport-warning-popover">
                        <div className="cad-viewport-warning-list">
                            {props.warnings.map((warning, index) => (
                                <div key={index} className="cad-viewport-warning-item">
                                    {warning}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        ) : undefined;

    const staleBanner =
        props.rebuildOnEdit === 'manual' && props.buildStale ? (
            <div className="cad-viewport-warning-strip">
                <div className="cad-viewport-warning-header">
                    <span className="codicon codicon-warning" />
                    <span className="cad-viewport-error-message">Model stale — parameters changed since last build</span>
                    <Tooltip content="Rebuild now" position="left">
                        <button className="theia-button secondary cad-viewport-error-dismiss" onClick={props.onRebuildDocument}>
                            <span className="codicon codicon-refresh" /> Rebuild
                        </button>
                    </Tooltip>
                </div>
            </div>
        ) : undefined;

    const banners =
        errorBanner !== undefined || warningStrip !== undefined || staleBanner !== undefined ? (
            <div className="cad-viewport-banners">
                {errorBanner}
                {warningStrip}
                {staleBanner}
            </div>
        ) : undefined;

    if (props.loading && props.tessData === undefined) {
        return (
            <div ref={containerRef} tabIndex={-1} className="cad-viewport loading">
                {banners}
                <NukeLoadingOverlay message={props.loadingMessage} subMessage="This may take a moment for large models" />
            </div>
        );
    }

    const documentEmpty = props.tessData === undefined && props.documentStore.hasDocument && !props.loading && !sketchActive;
    const noDocument = props.tessData === undefined && !props.documentStore.hasDocument && !props.loading;
    const dirtyMarker = props.dirty ? <span className="cad-viewport-dirty-marker" title="Unsaved changes" /> : null;

    const sketchOverlay = controller !== undefined && (
        <CadSketchOverlay
            controller={controller}
            documentStore={props.documentStore}
            messageService={props.messageService}
            setupVisible={props.sketchSetupVisible}
            featureCreationType={props.featureCreationType}
            featureCreationBodyId={props.featureCreationBodyId}
            editFeature={editFeature}
            facePickMode={props.facePickMode}
            dressUpPickMode={props.dressUpPickMode}
            holePickMode={props.holePickMode}
            shortcutBar={shortcutBar}
            sketchAutoDimension={props.sketchAutoDimension}
            ribbonLabels={props.ribbonLabels}
            ribbonPins={props.ribbonPins}
            onToggleRibbonPin={props.onToggleRibbonPin}
            templates={props.templates}
            onEnterSketch={props.onEnterSketch}
            onEnterSketchDraft={props.onEnterSketchDraft}
            onExitSketch={props.onExitSketch}
            onStartFeatureCreation={props.onStartFeatureCreation}
            onAddFeature={props.onAddFeature}
            onEditFeature={props.onEditFeature}
            onEditSketch={props.onEditSketch}
            sketchEditing={props.sketchEditing}
            onStartSketchSetup={props.onStartSketchSetup}
            onExportPython={props.onExportPython}
            onNewDocument={props.onNewDocument}
            onSaveDocument={props.onSaveDocument}
            onRebuildDocument={props.onRebuildDocument}
            onCancelFeatureCreation={props.onCancelFeatureCreation}
            onStartFacePick={props.onStartFacePick}
            onStartExternalGeometryPick={props.onStartExternalGeometryPick}
            onCancelFacePick={props.onFacePickCancel}
            onStartDressUpPick={props.onStartDressUpPick}
            onDressUpPickCancel={props.onDressUpPickCancel}
            onStartHolePick={props.onStartHolePick}
            onHolePickCancel={props.onHolePickCancel}
            curvePickMode={props.curvePickMode}
            onStartCurvePick={props.onStartCurvePick}
            onCurvePickCancel={props.onCurvePickCancel}
            onPreviewChange={props.onPreviewChange}
            measureActive={measureActive}
            measureCount={modeMeasurements.length}
            measureListOpen={measureListOpen}
            onToggleMeasure={handleToggleMeasure}
            onToggleMeasureList={handleToggleMeasureList}
            onCloseShortcutBar={closeShortcutBar}
        />
    );

    const templatePicker = props.templatePickerOpen ? (
        <DocumentTemplatePicker
            templates={props.templates}
            onSelect={(id) => {
                props.onCreateDocument(id);
                setShortcutBar(undefined);
            }}
            onCancel={props.onCancelTemplatePicker}
        />
    ) : undefined;

    const activeShading = SHADING_MODES.find((mode) => mode.id === shadingMode) ?? SHADING_MODES[0];
    const sectionLabel = sectionStatusLabel({ axis: sectionAxis, flip: sectionFlip, fraction: sectionFraction });
    const measureHint = !measureActive
        ? undefined
        : activeMeasureTool === 'radius'
          ? 'Measure: click a circular edge (Enter/Esc ends the tool)'
          : activeMeasureTool === 'angle'
            ? measurePending === undefined
                ? 'Measure: click the first point'
                : measureVertex === undefined
                  ? 'Measure: click the vertex (point B)'
                  : 'Measure: click the third point (Enter/Esc ends the tool)'
            : measurePending === undefined
              ? 'Measure: click the first point'
              : 'Measure: click the second point (Enter/Esc ends the tool)';
    const statusHints = [
        shadingMode === 'edgesOnly' ? 'Edges-only: face/solid picking disabled' : undefined,
        props.sectionActive ? `Section: ${sectionLabel} — Esc to exit` : undefined,
        explodeFactor > 0 ? `Explode ${Math.round(explodeFactor * 100)}% — F to refit` : undefined,
        measureActive && activeMeasureTool !== 'radius' && shadingMode === 'edgesOnly' && measureMode === 'model3d'
            ? 'Measure: point picking disabled by edges-only shading'
            : undefined,
        measureHint
    ].filter((hint): hint is string => hint !== undefined);

    const navCluster =
        props.tessData !== undefined && !sketchActive && !props.loading ? (
            <>
                <ViewerNavBar ref={navRef} onAction={handleViewerNavAction}>
                    <Tooltip content={`Shading: ${activeShading.label}`} position="left">
                        <button
                            className={`theia-button secondary cad-viewport-nav-button ${shadingMode !== 'shaded' ? 'active' : ''}`}
                            onClick={() => setOpenPopover(openPopover === 'shading' ? undefined : 'shading')}
                        >
                            <span className={`codicon ${activeShading.icon}`} />
                        </button>
                    </Tooltip>
                    <span className="cad-viewport-nav-divider" />
                    <Tooltip content="Section view" position="left">
                        <button
                            className={`theia-button secondary cad-viewport-nav-button ${props.sectionActive ? 'active' : ''}`}
                            onClick={handleToggleSection}
                        >
                            <span className="codicon codicon-nuke-cad-section" />
                        </button>
                    </Tooltip>
                    <span className="cad-viewport-nav-divider" />
                    <Tooltip content="Explode view — moves each solid outward from the model center (viewport only)" position="left">
                        <label className="cad-viewport-explode">
                            <span className="cad-viewport-explode-label">Explode</span>
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={Math.round(explodeFactor * 100)}
                                onChange={(event) => setExplodeFactor(Number(event.target.value) / 100)}
                            />
                            <span className="cad-viewport-explode-value">{Math.round(explodeFactor * 100)}%</span>
                        </label>
                    </Tooltip>
                </ViewerNavBar>
                {openPopover === 'shading' && (
                    <div className="cad-viewport-popover cad-viewport-nav-popover">
                        {SHADING_MODES.map((mode) => (
                            <Tooltip
                                key={mode.id}
                                content={mode.id === 'edgesOnly' ? `${mode.label} (face picking disabled)` : mode.label}
                                position="left"
                            >
                                <button
                                    className={`cad-viewport-shading-item${mode.id === shadingMode ? ' active' : ''}`}
                                    onClick={() => {
                                        setShadingMode(mode.id);
                                        viewportApi.current.setShading?.(mode.id);
                                        setOpenPopover(undefined);
                                    }}
                                >
                                    <span className={`codicon ${mode.icon}`} />
                                    <span className="cad-viewport-shading-label">{mode.label}</span>
                                    {mode.id === shadingMode && <span className="codicon codicon-check" />}
                                </button>
                            </Tooltip>
                        ))}
                        {shadingMode === 'xray' && (
                            <label className="cad-viewport-ghost-row">
                                Ghost
                                <input
                                    type="range"
                                    min={GHOST_OPACITY_MIN}
                                    max={GHOST_OPACITY_MAX}
                                    step={GHOST_OPACITY_STEP}
                                    value={ghostOpacity}
                                    onChange={(event) => {
                                        const value = Number(event.target.value);
                                        setGhostOpacity(value);
                                        viewportApi.current.setGhostOpacity?.(value);
                                    }}
                                />
                                <span>{Math.round(ghostOpacity * 100)}%</span>
                            </label>
                        )}
                    </div>
                )}
                {openPopover === 'section' && (
                    <div className="cad-viewport-popover cad-viewport-section-popover">
                        <div className="cad-viewport-section-row">
                            {SECTION_AXES.map((axis) => (
                                <Tooltip key={axis.id} content={`${axis.label} axis`} position="left">
                                    <button
                                        className={`cad-viewport-section-axis${axis.id === sectionAxis ? ' active' : ''}`}
                                        onClick={() => setSectionAxis(axis.id)}
                                    >
                                        {axis.label}
                                    </button>
                                </Tooltip>
                            ))}
                            <Tooltip content="Keep the other half" position="top">
                                <button
                                    className={`cad-viewport-section-flip${sectionFlip ? ' active' : ''}`}
                                    onClick={() => setSectionFlip(!sectionFlip)}
                                >
                                    Flip
                                </button>
                            </Tooltip>
                        </div>
                        <label className="cad-viewport-section-slider-row">
                            Offset
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={Math.round(sectionFraction * 100)}
                                onChange={(event) => setSectionFraction(clampSectionFraction(Number(event.target.value) / 100))}
                            />
                            <span>{Math.round(sectionFraction * 100)}%</span>
                        </label>
                    </div>
                )}
                {statusHints.length > 0 && (
                    <div
                        className="cad-viewport-shading-hint nuke-viewer-status-line"
                        style={navWidth > 0 ? { maxWidth: `calc(100% - ${navWidth + 40}px)` } : undefined}
                    >
                        <span className="codicon codicon-info" />
                        <span className="cad-viewport-shading-hint-text">{statusHints.join(' · ')}</span>
                    </div>
                )}
            </>
        ) : undefined;

    const chromeVisible = props.tessData !== undefined && !sketchActive && !props.loading;

    const viewCube = chromeVisible ? (
        <ViewCube
            ref={(handle) => {
                viewCubeRef.current = handle;
            }}
            onSnap={(direction) => viewportApi.current.snapView?.(direction)}
        />
    ) : undefined;

    const viewBadge = chromeVisible ? <ViewBadge text={`${viewName} view`} /> : undefined;

    const measureListPopover = measureListOpen ? (
        <MeasureListPopover
            className={measureMode === 'sketch' ? 'cad-sketch-measure-popover' : 'cad-viewport-measure-popover'}
            measurements={modeMeasurements}
            tool={activeMeasureTool}
            showToolSelector={measureMode === 'model3d'}
            lengthDecimals={props.lengthDecimals}
            angleDecimals={props.angleDecimals}
            pinnedIds={new Set((props.documentStore.document?.measurements ?? []).map((saved) => saved.id))}
            canPin={measureMode === 'model3d' && props.documentStore.hasDocument}
            onToolChange={handleMeasureToolChange}
            onPin={handleMeasurePin}
            onUnpin={handleMeasureUnpin}
            onDelete={handleMeasureDelete}
            onClear={handleMeasureClear}
            onClose={() => setMeasureListOpen(false)}
        />
    ) : undefined;

    if (sketchActive) {
        return (
            <div ref={containerRef} tabIndex={-1} className="cad-viewport empty">
                {banners}
                {props.sketchEntering && <NukeLoadingOverlay message="Starting sketch solver..." />}
                {sketchOverlay}
                {templatePicker}
                {measureListPopover}
            </div>
        );
    }

    if (noDocument) {
        return (
            <div ref={containerRef} tabIndex={-1} className="cad-viewport empty">
                {banners}
                {dirtyMarker}
                <LoadingAnimations />
                <div className="cad-viewport-empty-wrapper">
                    <NukeEmptyState
                        icon="globe"
                        title="CAD Viewport"
                        message="Open a build123d/CadQuery script, a STEP/STP/BREP file, or a .nuke-cad document to view and inspect geometry."
                        hint="Supported formats: .py, .step, .stp, .brep, .nuke-cad"
                    >
                        <button className="theia-button" onClick={props.onNewDocument}>
                            <span className="codicon codicon-new-file" /> New Document
                        </button>
                        <button className="theia-button secondary open-cad-model-button" onClick={props.onOpenModel}>
                            <span className="codicon codicon-folder-opened" /> Open CAD Model...
                        </button>
                    </NukeEmptyState>
                </div>
                {sketchOverlay}
                {templatePicker}
            </div>
        );
    }

    if (documentEmpty) {
        return (
            <div ref={containerRef} tabIndex={-1} className="cad-viewport empty">
                {banners}
                {dirtyMarker}
                <div className="cad-viewport-empty-wrapper">
                    <div className="cad-viewport-document-empty">
                        <span className="codicon codicon-nuke-cad-sketch cad-viewport-document-empty-icon" />
                        <div className="cad-viewport-document-empty-title">Empty document</div>
                        <div className="cad-viewport-document-empty-message">Create a sketch or open a model to get started.</div>
                        <div className="cad-viewport-document-empty-hint">Sketches start on a datum plane or a planar face.</div>
                        <div className="cad-viewport-document-empty-actions">
                            <button className="theia-button" onClick={props.onStartSketchSetup}>
                                <span className="codicon codicon-nuke-cad-sketch" /> Create Sketch
                            </button>
                            <button className="theia-button secondary open-cad-model-button" onClick={props.onOpenModel}>
                                <span className="codicon codicon-folder-opened" /> Open CAD Model…
                            </button>
                        </div>
                    </div>
                </div>
                {sketchOverlay}
                {templatePicker}
            </div>
        );
    }

    return (
        <div ref={containerRef} tabIndex={-1} className="cad-viewport">
            {banners}
            {dirtyMarker}
            {props.loading && <NukeLoadingOverlay message={props.loadingMessage} />}
            {navCluster}
            {viewCube}
            {viewBadge}
            {measureListPopover}
            {sketchOverlay}
            {templatePicker}
            {props.connectorPickMode !== undefined && (
                <div className="cad-sketch-face-pick-banner">
                    <span>
                        Connector pick (mate side {props.connectorPickMode}): click a part face to pick its nearest connector — right-click
                        or Escape cancels
                    </span>
                    <button className="theia-button secondary" onClick={props.onConnectorPickCancel}>
                        Cancel
                    </button>
                </div>
            )}
            {props.drawingDimensionPickMode !== undefined && (
                <div className="cad-sketch-face-pick-banner">
                    <span className="codicon codicon-target" />
                    <span>
                        Dimension {props.drawingDimensionPickMode.kind}: click{' '}
                        {drawingDimensionTargetsNeeded(props.drawingDimensionPickMode.kind) === 2 ? 'two edges' : 'an edge'} (
                        {props.drawingDimensionPickMode.picked}/{drawingDimensionTargetsNeeded(props.drawingDimensionPickMode.kind)}) —
                        right-click or Escape cancels
                    </span>
                    <button className="theia-button secondary" onClick={props.onDrawingDimensionEdgePickCancel}>
                        Cancel
                    </button>
                </div>
            )}
            {props.documentStore.hasDocument && !sketchActive && (
                <AssemblyInstanceList
                    assembly={props.documentStore.document !== undefined ? getAssemblySection(props.documentStore.document) : undefined}
                    onGround={props.onGroundInstance}
                    onSelect={props.onSelectInstance}
                    onDelete={props.onDeleteInstance}
                    onRename={props.onRenameInstance}
                    onAddInstance={props.onAddInstance}
                    onAddMate={props.onOpenMateDialog}
                />
            )}
            {props.mateDialogOpen && <AssemblyMateDialog {...props} />}
            {props.appearanceTarget !== undefined && <BodyAppearanceDialogHost {...props} />}
        </div>
    );
}

/** Adapter: feed the per-body Appearance dialog from the document store. */
function BodyAppearanceDialogHost(props: CadViewportComponentProps): React.ReactElement | null {
    const target = props.appearanceTarget;
    if (target === undefined) {
        return null;
    }
    const appearance = props.documentStore.document?.bodies.find((body) => body.id === target.bodyId)?.appearance;
    return (
        <BodyAppearanceDialog
            key={target.bodyId}
            target={target}
            appearance={appearance}
            presets={props.appearancePresets}
            selectionBodyIds={props.appearanceSelectionBodyIds}
            onApply={(next) => props.onApplyAppearance(target.bodyId, next)}
            onApplyToBodies={props.onApplyAppearanceToBodies}
            onRemove={() => props.onRemoveAppearance(target.bodyId)}
            onRemoveFromBodies={props.onRemoveAppearanceFromBodies}
            onSavePreset={props.onSaveAppearancePreset}
            onDeletePreset={props.onDeleteAppearancePreset}
            onClose={props.onCloseAppearance}
        />
    );
}

/** Adapter: feed the mate dialog from the document store's assembly section. */
function AssemblyMateDialog(props: CadViewportComponentProps): React.ReactElement | null {
    const assembly = props.documentStore.document !== undefined ? getAssemblySection(props.documentStore.document) : undefined;
    if (assembly === undefined) {
        return null;
    }
    return (
        <MateDialog
            instances={assembly.instances}
            connectors={assembly.connectors}
            pickedConnectorA={props.mateConnectorA}
            pickedConnectorB={props.mateConnectorB}
            onPickConnector={props.onStartConnectorPick}
            previewEnabled={props.matePreviewEnabled}
            onPreviewChange={props.onMatePreviewChange}
            onSubmit={props.onMateSubmit}
            onClose={props.onCloseMateDialog}
        />
    );
}

interface MeasureListPopoverProps {
    readonly className: string;
    readonly measurements: readonly Measurement[];
    /** Active capture tool (distance/angle/radius); sketch mode is distance. */
    readonly tool: MeasureToolMode;
    /** Show the mode selector row (model3d popover only). */
    readonly showToolSelector: boolean;
    /** Display precision for distance/radius rows. */
    readonly lengthDecimals: number;
    /** Display precision for angle rows. */
    readonly angleDecimals: number;
    /** Saved-measurement ids from the document block; rows in this set render pinned. */
    readonly pinnedIds: ReadonlySet<string>;
    /** Pin buttons render only for pinnable rows (model3d documents only). */
    readonly canPin: boolean;
    readonly onToolChange: (tool: MeasureToolMode) => void;
    readonly onPin: (id: string) => void;
    readonly onUnpin: (id: string) => void;
    readonly onDelete: (id: string) => void;
    readonly onClear: () => void;
    readonly onClose: () => void;
}

/**
 * Retag an overlay measurement to a new id, preserving its derived fields.
 *
 * Pinning mints a store id for the saved entry; the ephemeral copy takes it
 * so pin state tracks by one id across rebuilds.
 */
function retagMeasurement(measurement: Measurement, id: string): Measurement {
    if (isMeasureAngle(measurement)) {
        return createMeasureAngle(id, measurement.kind, measurement.a, measurement.b, measurement.c);
    }
    if (isMeasureRadius(measurement)) {
        return createMeasureRadius(id, measurement.center, measurement.radius);
    }
    return createMeasureSegment(id, measurement.kind, measurement.a, measurement.b);
}

const MEASURE_HEADER_TARGET = headerRegionTarget('.cad-measure-header');

const MEASURE_MODE_LABELS: readonly { id: MeasureToolMode; label: string }[] = [
    { id: 'distance', label: 'Distance' },
    { id: 'angle', label: 'Angle' },
    { id: 'radius', label: 'Radius' }
];

function MeasureListPopover(props: MeasureListPopoverProps): React.ReactElement {
    const drag = useDraggablePanel({ canDrag: MEASURE_HEADER_TARGET, canResetFrom: MEASURE_HEADER_TARGET });
    const modeHint =
        props.tool === 'radius'
            ? 'Click a circular edge in the viewport to measure its radius.'
            : props.tool === 'angle'
              ? 'Click three points (A, vertex B, C) in the viewport to measure the angle at B.'
              : 'Click two points to measure a distance.';
    return (
        <div className={props.className} ref={drag.panelRef} style={drag.style}>
            <div className="cad-measure-header" {...drag.handleProps}>
                <span className="cad-measure-title">Measurements</span>
                <span className="cad-measure-badge">{props.measurements.length}</span>
                <Tooltip content="Close" position="left">
                    <button className="theia-button secondary cad-measure-row-remove" onClick={props.onClose}>
                        <span className="codicon codicon-close" />
                    </button>
                </Tooltip>
            </div>
            {props.showToolSelector && (
                <div className="cad-measure-modes">
                    {MEASURE_MODE_LABELS.map((mode) => (
                        <button
                            key={mode.id}
                            className={`theia-button secondary cad-measure-mode${mode.id === props.tool ? ' active' : ''}`}
                            onClick={() => props.onToolChange(mode.id)}
                        >
                            {mode.label}
                        </button>
                    ))}
                </div>
            )}
            {props.measurements.length === 0 ? (
                <div className="cad-measure-empty">{modeHint}</div>
            ) : (
                <div className="cad-measure-list">
                    {props.measurements.map((measurement) => (
                        <div key={measurement.id} className="cad-measure-row">
                            <span className="cad-measure-value">
                                {formatMeasurementValue(measurement, {
                                    length: props.lengthDecimals,
                                    angle: props.angleDecimals
                                })}
                            </span>
                            {props.canPin &&
                                (props.pinnedIds.has(measurement.id) ? (
                                    <Tooltip content="Unpin measurement (stop saving it in the document)" position="left">
                                        <button
                                            className="theia-button secondary cad-measure-row-remove"
                                            onClick={() => props.onUnpin(measurement.id)}
                                        >
                                            <span className="codicon codicon-pinned" />
                                        </button>
                                    </Tooltip>
                                ) : (
                                    <Tooltip content="Pin measurement (save it in the document)" position="left">
                                        <button
                                            className="theia-button secondary cad-measure-row-remove"
                                            onClick={() => props.onPin(measurement.id)}
                                        >
                                            <span className="codicon codicon-pin" />
                                        </button>
                                    </Tooltip>
                                ))}
                            <Tooltip content="Delete measurement" position="left">
                                <button
                                    className="theia-button secondary cad-measure-row-remove"
                                    onClick={() => props.onDelete(measurement.id)}
                                >
                                    <span className="codicon codicon-close" />
                                </button>
                            </Tooltip>
                        </div>
                    ))}
                </div>
            )}
            <div className="cad-measure-footer">
                <button
                    className="theia-button secondary cad-measure-clear"
                    disabled={props.measurements.length === 0}
                    onClick={props.onClear}
                >
                    Clear All
                </button>
                <span className="cad-measure-note">{MEASURE_CLEAR_NOTE}</span>
            </div>
        </div>
    );
}

interface OriginAxesVisibility {
    readonly enabled: boolean;
    readonly x: boolean;
    readonly y: boolean;
    readonly z: boolean;
}

interface ViewportApi {
    readonly controller: SketchModeController;
    readonly cleanup: () => void;
    readonly updateModel: (tessData?: TessData) => void;
    readonly updateSelectedCurve: (curveId: string | undefined) => void;
    readonly setFacePickMode: (mode?: 'sketchDatum' | 'externalGeometry') => void;
    readonly setDressUpPickMode: (mode?: DressUpPickMode) => void;
    readonly setHolePickMode: (active: boolean) => void;
    readonly setCurvePickMode: (active: boolean) => void;
    readonly setDrawingDimensionPickMode: (active: boolean) => void;
    readonly setConnectorPickMode: (active: boolean) => void;
    readonly setConnectorTriads: (triads: readonly ConnectorTriad[]) => void;
    readonly setPreviewTessellation: (tessData?: TessData) => void;
    readonly setOriginAxes: (axes: OriginAxesVisibility, suppressed?: boolean) => void;
    readonly fitView: () => void;
    readonly zoomView: (factor: number) => void;
    readonly setStandardView: (view: 'iso' | 'top' | 'front' | 'right') => void;
    readonly getCameraState: () => CadCameraState;
    readonly setCameraState: (state: CadCameraState) => void;
    readonly setShading: (mode: ShadingMode) => void;
    readonly setGhostOpacity: (value: number) => void;
    readonly setViewportBackground: (style: ViewportBackgroundStyle) => void;
    readonly setNavigationStyle: (style: NavigationStyle) => void;
    readonly setColorByMaterial: (enabled: boolean) => void;
    readonly setSection: (section?: SectionState) => void;
    readonly setExplodeFactor: (factor: number) => void;
    readonly snapView: (direction: readonly [number, number, number]) => void;
    readonly updateMeasureState: (state: MeasureViewState) => void;
    readonly setMeasurementDecimals: (decimals: MeasurementDecimals) => void;
    readonly setAutoDimensionEnabled: (enabled: boolean) => void;
}

function initViewport(
    container: HTMLDivElement,
    tessData: TessData | undefined,
    documentStore: CadDocumentStore,
    onSelect: (selection: CadSelection) => void,
    subscribeSelection: (listener: (selection: CadSelection) => void) => Disposable,
    subscribeHiddenSolids: (listener: (ids: readonly number[]) => void) => Disposable,
    subscribeThemeChange: (listener: () => void) => Disposable,
    onControllerReady: (controller: SketchModeController, camera: THREE.PerspectiveCamera) => void,
    onFacePick: (hit: FacePickHit) => void,
    onFacePickCancel: () => void,
    onEdgePick: (hit: EdgePickHit, edgeLines?: readonly THREE.Line[]) => void,
    onFacePickDressUp: (hit: FacePickHit) => void,
    onDressUpPickCancel: () => void,
    onStartHolePick: (callback: (ref: TopologyRef, uv: [number, number]) => void) => void,
    onHolePick: (hit: FacePickHit) => void,
    onHolePickCancel: () => void,
    initialHolePickMode: boolean,
    onCurvePick: (curveId: string) => void,
    onCurvePickCancel: () => void,
    initialCurvePickMode: boolean,
    onDrawingDimensionEdgePick: (hit: EdgePickHit) => void,
    onDrawingDimensionEdgePickCancel: () => void,
    initialDrawingDimensionPickMode: boolean,
    onConnectorPick: (connectorId: string) => void,
    onConnectorPickCancel: () => void,
    initialConnectorPickMode: boolean,
    messageService: MessageService,
    onToggleSketchMode: () => void,
    onExitSketch: () => Promise<void>,
    onExitSection: () => void,
    onMeasurePoint: (point: MeasurePoint3D) => void,
    onMeasureRadius: (center: MeasurePoint3D, radius: number) => void,
    onMeasureDeactivate: () => void,
    onShortcutBarRequest: (mode: 'document' | 'sketch', anchor: { x: number; y: number }) => void,
    onEditFeatureRequest: (featureId: string) => void,
    onStartMeasureTool: (tool: MeasureToolMode) => void,
    onResetExplode: () => void,
    OrbitControlsCtor: new (
        camera: THREE.Camera,
        domElement: HTMLElement
    ) => {
        enabled: boolean;
        target: THREE.Vector3;
        mouseButtons: { LEFT?: number | null; MIDDLE?: number | null; RIGHT?: number | null };
        touches: { ONE?: number | null; TWO?: number | null };
        update: () => void;
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
        dispose(): void;
    },
    initialViewportBackground: ViewportBackgroundStyle,
    initialNavigationStyle: NavigationStyle,
    initialColorByMaterial: boolean,
    initialMeasurementDecimals: MeasurementDecimals,
    initialOriginAxes: OriginAxesVisibility,
    isSectionActive: () => boolean,
    onClosePopover: () => void,
    onToggleSection: () => void,
    onHideSolid: (solidId: number) => void,
    onIsolateSolid: (solidId: number) => void,
    onHideSolids: (solidIds: readonly number[]) => void,
    onIsolateSolids: (solidIds: readonly number[]) => void,
    onShowAllSolids: () => void,
    onClearSelection: () => void,
    onRevealFeature: (featureId: string) => void,
    onOpenBodyAppearance: (bodyId: string) => void,
    onViewCubeUpdate: (quaternion: readonly [number, number, number, number]) => void,
    onViewNameChange: (name: string) => void
): ViewportApi {
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 300;

    const scene = new THREE.Scene();
    // Viewport background style (theme/dark/light/gradient pref): gradient
    // leaves the scene transparent so the container's CSS backdrop shows
    // through; every other style resolves to a solid scene color.
    let backgroundStyle = initialViewportBackground;
    const applyBackground = (): string => {
        const themeBackground = readThemeColor(container, '--theia-editor-background', '#1e1e1e');
        const resolved = resolveViewportBackground(backgroundStyle, themeBackground);
        container.classList.toggle('cad-viewport-gradient', backgroundStyle === 'gradient');
        scene.background = resolved === undefined ? null : new THREE.Color(resolved);
        return themeBackground;
    };
    const background = applyBackground();
    const viewportColors = cadViewportColors(background, readThemeColor(container, '--theia-foreground', '#cccccc'));

    // Near/far are recomputed from the scene scale before every render (see
    // renderScene); these values only cover the pre-fit placeholder camera.
    const initialClip = computeClipPlanes(Math.sqrt(300), 5);
    const camera = new THREE.PerspectiveCamera(45, width / height, initialClip.near, initialClip.far);
    camera.name = 'cad-perspective-camera';
    camera.position.set(10, 10, 10);
    // Z-up world: OrbitControls freezes its orbit pole from camera.up at
    // construction, so this must precede controls creation.
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);

    let controls = new OrbitControlsCtor(camera, renderer.domElement);
    let navigationStyle = initialNavigationStyle;
    applyNavigationStyle(controls, navigationStyle);
    controls.target.set(0, 0, 0);
    controls.update();

    // Measurement labels and popover rows share this mutable precision; the
    // React effect pushes preference changes through `setMeasurementDecimals`.
    const measurementDecimals: { length: number; angle: number } = {
        length: initialMeasurementDecimals.length,
        angle: initialMeasurementDecimals.angle
    };

    // Material coloring is display-only: the preference effect pushes changes
    // through `setColorByMaterial`, which re-derives the per-body materials.
    let colorByMaterial = initialColorByMaterial;

    // Additive selection holds navigation still: three.js maps Left+Ctrl/Meta
    // to pan, which fights Ctrl+click multi-pick (any drag while the modifier
    // is down moves the camera). While Ctrl/Cmd is held the orbit controls
    // stay disabled, so hover+click accumulates the selection without moving
    // the view; plain gestures are untouched.
    let additiveModifierHeld = false;
    const applyControlsEnabled = (): void => {
        controls.enabled = !additiveModifierHeld;
    };

    const modelGroup = new THREE.Group();
    modelGroup.name = 'cad-model';
    scene.add(modelGroup);

    // Ghosted feature-preview solids live in their own group so model rebuilds
    // never dispose them; the dialog's preview toggle owns their lifetime.
    const previewGroup = new THREE.Group();
    previewGroup.name = 'cad-preview';
    scene.add(previewGroup);
    let previewMeshes: THREE.Mesh[] = [];

    // Connector-frame triads for mate authoring: one RGB triad per connector
    // at its solved assembly pose. Shown during connector-pick mode (hover
    // triad highlight of connector frames) and the ghosted mate preview
    // (both connectors at solved poses in `cad-preview`); failures clear
    // silently per the preview contract.
    const connectorGroup = new THREE.Group();
    connectorGroup.name = 'cad-connectors';
    scene.add(connectorGroup);
    let connectorTriadLines: THREE.LineSegments[] = [];
    const CONNECTOR_TRIAD_SIZE = 2.5;
    const setConnectorTriads = (triads: readonly ConnectorTriad[]): void => {
        for (const lines of connectorTriadLines) {
            connectorGroup.remove(lines);
            lines.geometry.dispose();
        }
        connectorTriadLines = [];
        if (triads.length === 0) {
            renderScene();
            return;
        }
        const scale = Math.max(lastDiag * 0.02, 1e-3);
        for (const triad of triads) {
            const origin = new THREE.Vector3(triad.origin[0], triad.origin[1], triad.origin[2]);
            const axes: Array<{ dir: [number, number, number]; color: [number, number, number] }> = [
                { dir: [triad.xAxis[0], triad.xAxis[1], triad.xAxis[2]], color: [1, 0.25, 0.25] },
                { dir: [triad.yAxis[0], triad.yAxis[1], triad.yAxis[2]], color: [0.25, 1, 0.25] },
                { dir: [triad.zAxis[0], triad.zAxis[1], triad.zAxis[2]], color: [0.3, 0.5, 1] }
            ];
            const positions = new Float32Array(18);
            const colors = new Float32Array(18);
            axes.forEach((axis, i) => {
                const length = Math.hypot(...axis.dir) || 1;
                const end = origin
                    .clone()
                    .add(
                        new THREE.Vector3(axis.dir[0] / length, axis.dir[1] / length, axis.dir[2] / length).multiplyScalar(
                            scale * CONNECTOR_TRIAD_SIZE
                        )
                    );
                positions.set([origin.x, origin.y, origin.z, end.x, end.y, end.z], i * 6);
                colors.set([...axis.color, ...axis.color], i * 6);
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            const lines = new THREE.LineSegments(
                geometry,
                new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2, depthTest: false, transparent: true, opacity: 0.95 })
            );
            lines.renderOrder = 10;
            connectorGroup.add(lines);
            connectorTriadLines.push(lines);
        }
        renderScene();
    };

    const baseColor = new THREE.Color(viewportColors.body);
    const edgeColor = new THREE.Color(viewportColors.edges);
    const selectedColor = new THREE.Color(readThemeColor(container, '--theia-focusBorder', '#007fd4'));

    let meshes: THREE.Mesh[] = [];
    let edgeLines: THREE.Line[] = [];
    let curveLines: THREE.Line[] = [];
    let selectedCurveId: string | undefined;
    let currentSelection: CadSelection = {};
    /** A selected solid drives Clear Selection (and makes F fit-to-selection). */
    const hasViewportSelection = (): boolean => currentSelection.solidId !== undefined || (currentSelection.solidIds?.length ?? 0) > 0;
    // Solids hidden through the Model Outline hide/isolate actions; cleared on
    // every new model (solid indices are positional and can shuffle).
    let hiddenSolidIds = new Set<number>();
    let activeFacePickMode: 'sketchDatum' | 'externalGeometry' | undefined;
    let activeDressUpPickMode: DressUpPickMode | undefined;
    let activeHolePickMode = initialHolePickMode;
    let activeCurvePickMode = initialCurvePickMode;
    let activeDrawingDimensionPickMode = initialDrawingDimensionPickMode;
    let activeConnectorPickMode = initialConnectorPickMode;
    /** Curve hovered during curve-pick mode; highlighted like a selection. */
    let curvePickHoverId: string | undefined;
    let lastCenter = new THREE.Vector3();
    let lastDiag = 10;
    // Display-only world-origin triad: three RGB lines at the scene origin,
    // each parented to `origin-axes` so per-axis visibility is one flag per
    // line. Scale follows the model diagonal so it stays legible at tokamak
    // scale; never document state, never a build/export input. The master
    // preference and the presence of a loaded tessellation gate the group.
    const ORIGIN_AXIS_COLORS = ['#e05252', '#4caf50', '#3b82f6'] as const;
    const ORIGIN_AXIS_NAMES = ['x', 'y', 'z'] as const;
    const originAxesGroup = new THREE.Group();
    originAxesGroup.name = 'origin-axes';
    scene.add(originAxesGroup);
    /** Master Show axes preference; per-axis flags only matter while on. */
    let originAxesEnabled = initialOriginAxes.enabled;
    /** Sketch setup/entering hides the whole group on top of the controller check. */
    let originAxesSuppressed = false;
    const originAxisLines = ORIGIN_AXIS_NAMES.map((axis, index) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const material = new THREE.LineBasicMaterial({
            color: ORIGIN_AXIS_COLORS[index],
            depthTest: false,
            transparent: true,
            opacity: 0.9,
            toneMapped: false
        });
        const line = new THREE.Line(geometry, material);
        line.name = `origin-axis-${axis}`;
        line.renderOrder = 990;
        // Axes stay visible over geometry; skip frustum culling because the
        // geometry grows with the model without a recomputed bounding sphere.
        line.frustumCulled = false;
        originAxesGroup.add(line);
        return line;
    });
    const applyOriginAxesLength = (length: number): void => {
        ORIGIN_AXIS_NAMES.forEach((axis, index) => {
            const position = originAxisLines[index].geometry.getAttribute('position') as THREE.BufferAttribute;
            position.setXYZ(0, 0, 0, 0);
            position.setXYZ(1, axis === 'x' ? length : 0, axis === 'y' ? length : 0, axis === 'z' ? length : 0);
            position.needsUpdate = true;
        });
    };
    applyOriginAxesLength(5);
    // Declared before buildModel runs: applyShading reads both immediately.
    let shading: ShadingMode = 'shaded';
    let ghostOpacity = DEFAULT_GHOST_OPACITY;
    // Section mode: plane recomputed from this tessellation's bounding box.
    let currentTessData: TessData | undefined = tessData;
    let activeSection: SectionState | undefined;
    // Explode view: per-solid, transform-only viewport state. Offsets are
    // re-planned from the new payload after every buildModel; never document
    // state, never geometry edits (the reuse pool is untouched).
    let explodeFactor = 0;
    let explodeCentroids: ExplodeSolidCentroid[] | undefined;
    /** Last pointer position inside the container, used to anchor the Q shortcut bar. */
    let lastPointerPosition = { x: container.clientWidth / 2, y: container.clientHeight / 2 };

    const highlightColor = new THREE.Color(readThemeColor(container, '--theia-focusBorder', '#007fd4'));
    const faceHighlighter = new FaceHighlighter(highlightColor);
    faceHighlighter.attach(modelGroup);
    const edgeHighlighter = new EdgeHighlighter(highlightColor);
    edgeHighlighter.attach(modelGroup);

    // Shared materials: one instance per shading role instead of one per face
    // mesh (hundreds at tokamak scale). Selection highlight is a material swap
    // between the body and highlight roles; shading flags are applied to both
    // roles at once. Theme changes re-color these in place.
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide });
    const highlightMaterial = new THREE.MeshStandardMaterial({
        color: highlightColor,
        roughness: 0.6,
        metalness: 0.1,
        side: THREE.DoubleSide
    });
    const edgeLineMaterial = new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.85 });
    const curveLineMaterial = new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.95, linewidth: 2 });
    const curveLineHighlightMaterial = new THREE.LineBasicMaterial({
        color: highlightColor,
        transparent: true,
        opacity: 0.95,
        linewidth: 2
    });
    const previewGhostMaterial = new THREE.MeshStandardMaterial({
        color: baseColor,
        roughness: 0.6,
        metalness: 0.1,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: DEFAULT_GHOST_OPACITY,
        depthWrite: false
    });

    /**
     * Per-body display overrides. Bodies without an override keep the shared
     * body/highlight materials above; every overridden body gets a private
     * clone, so color and opacity never leak to other bodies. `color` is the
     * effective fixed color (explicit appearance color, else the material
     * palette color when `nukeCad.colorByMaterial` is on) and stays fixed
     * through theme changes; `opacity` is the explicit alpha (shaded mode
     * only). The map is rebuilt from the document on store changes and
     * preference toggles; replaced/removed entries are disposed.
     */
    interface BodyAppearanceMaterial {
        readonly material: THREE.MeshStandardMaterial;
        readonly color?: string;
        readonly opacity?: number;
    }
    let bodyAppearanceMaterials = new Map<string, BodyAppearanceMaterial>();

    const disposeBodyAppearanceMaterials = (): void => {
        for (const entry of bodyAppearanceMaterials.values()) {
            entry.material.dispose();
        }
        bodyAppearanceMaterials = new Map();
    };

    const syncBodyAppearances = (): void => {
        const doc = documentStore.document;
        const next = new Map<string, BodyAppearanceMaterial>();
        for (const body of doc?.bodies ?? []) {
            const appearance = resolveBodyDisplayAppearance(doc, body.id, colorByMaterial);
            if (appearance === undefined) {
                continue;
            }
            const previous = bodyAppearanceMaterials.get(body.id);
            // Unchanged overrides keep their material object: live meshes stay
            // assigned across unrelated document edits (no shader churn).
            if (previous !== undefined && previous.color === appearance.color && previous.opacity === appearance.opacity) {
                next.set(body.id, previous);
                continue;
            }
            const material = bodyMaterial.clone();
            material.color.set(appearance.color ?? baseColor);
            material.opacity = appearance.opacity ?? 1;
            next.set(body.id, { material, color: appearance.color, opacity: appearance.opacity });
        }
        for (const [bodyId, entry] of bodyAppearanceMaterials) {
            if (next.get(bodyId) !== entry) {
                entry.material.dispose();
            }
        }
        bodyAppearanceMaterials = next;
    };

    const appearanceMaterial = (bodyId: unknown): THREE.MeshStandardMaterial | undefined =>
        typeof bodyId === 'string' ? bodyAppearanceMaterials.get(bodyId)?.material : undefined;

    /**
     * Fixed colors (explicit appearance or material palette) stay through
     * theme changes; opacity-only overrides take the freshly resolved theme
     * body color.
     */
    const recolorBodyAppearanceMaterials = (): void => {
        for (const entry of bodyAppearanceMaterials.values()) {
            if (entry.color !== undefined) {
                entry.material.color.set(entry.color);
            } else {
                entry.material.color.copy(baseColor);
            }
        }
    };

    // Shared orientation cube: the scene pushes the live camera orientation
    // to the React chrome on every renderScene — never React state, so
    // orbiting causes no re-renders. The cube itself is hidden with no model
    // by conditional rendering (chromeVisible), not from in here.
    const updateViewCube = (): void => {
        const quaternion = camera.quaternion;
        onViewCubeUpdate([quaternion.x, quaternion.y, quaternion.z, quaternion.w]);
    };
    // Maps a normalized camera direction to its standard-view name.
    const viewNameForDirection = (dir: readonly [number, number, number]): string => {
        const v = new THREE.Vector3(...dir).normalize();
        const tol = 0.001;
        if (v.x > 1 - tol) {
            return 'Right';
        }
        if (v.x < -(1 - tol)) {
            return 'Left';
        }
        if (v.y > 1 - tol) {
            return 'Back';
        }
        if (v.y < -(1 - tol)) {
            return 'Front';
        }
        if (v.z > 1 - tol) {
            return 'Top';
        }
        if (v.z < -(1 - tol)) {
            return 'Bottom';
        }
        return 'Iso';
    };

    // Measure tool overlays: measurement lines and endpoint spheres live in a
    // scene-level group (never the model group, so rebuilds don't dispose them
    // implicitly), and their distance labels are imperative DOM positioned on
    // every renderScene exactly like the shared cube — no React state,
    // no animation loop.
    const MEASURE_MARKER_PX = 6;
    const measureGroup = new THREE.Group();
    measureGroup.name = 'cad-measure-layer';
    measureGroup.visible = false;
    scene.add(measureGroup);
    const measureLabelLayer = document.createElement('div');
    measureLabelLayer.className = 'cad-measure-label-layer';
    container.appendChild(measureLabelLayer);

    const measureLineMaterial = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 });
    measureLineMaterial.color = highlightColor;
    const measureSphereMaterial = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 });
    measureSphereMaterial.color = highlightColor;
    const measureSphereGeometry = new THREE.SphereGeometry(1, 12, 8);

    interface SegmentVisual {
        readonly type: 'segment';
        measurement: MeasureSegment;
        line: THREE.Line;
        sphereA: THREE.Mesh;
        sphereB: THREE.Mesh;
        label: HTMLDivElement;
    }
    interface AngleVisual {
        readonly type: 'angle';
        measurement: MeasureAngle;
        lineBA: THREE.Line;
        lineBC: THREE.Line;
        sphereA: THREE.Mesh;
        sphereB: THREE.Mesh;
        sphereC: THREE.Mesh;
        label: HTMLDivElement;
    }
    interface RadiusVisual {
        readonly type: 'radius';
        measurement: MeasureRadius;
        sphereCenter: THREE.Mesh;
        label: HTMLDivElement;
    }
    type MeasureVisual = SegmentVisual | AngleVisual | RadiusVisual;
    const measureVisuals = new Map<string, MeasureVisual>();
    let measureState: MeasureViewState = { active: false, mode: 'model3d', tool: 'distance', measurements: [] };
    let measureHover: MeasurePoint3D | undefined;

    const pendingLineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const pendingLine = new THREE.Line(pendingLineGeometry, measureLineMaterial);
    pendingLine.name = 'cad-measure-pending-line';
    pendingLine.renderOrder = 999;
    pendingLine.visible = false;
    measureGroup.add(pendingLine);
    const pendingMarker = new THREE.Mesh(measureSphereGeometry, measureSphereMaterial);
    pendingMarker.name = 'cad-measure-pending-marker';
    pendingMarker.renderOrder = 1000;
    pendingMarker.visible = false;
    measureGroup.add(pendingMarker);
    // Angle mode: second pending point (the vertex B pick).
    const pendingVertexMarker = new THREE.Mesh(measureSphereGeometry, measureSphereMaterial);
    pendingVertexMarker.name = 'cad-measure-pending-vertex-marker';
    pendingVertexMarker.renderOrder = 1000;
    pendingVertexMarker.visible = false;
    measureGroup.add(pendingVertexMarker);
    const pendingLabel = document.createElement('div');
    pendingLabel.className = 'cad-measure-label cad-measure-label-pending';
    pendingLabel.style.display = 'none';
    measureLabelLayer.appendChild(pendingLabel);

    const setMeasureLinePoints = (line: THREE.Line, a: MeasurePoint3D, b: MeasurePoint3D): void => {
        const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (attribute === undefined || attribute.count !== 2) {
            line.geometry.dispose();
            line.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
            return;
        }
        attribute.setXYZ(0, a[0], a[1], a[2]);
        attribute.setXYZ(1, b[0], b[1], b[2]);
        attribute.needsUpdate = true;
    };
    setMeasureLinePoints(pendingLine, [0, 0, 0], [0, 0, 0]);

    const makeMeasureSphere = (): THREE.Mesh => {
        const sphere = new THREE.Mesh(measureSphereGeometry, measureSphereMaterial);
        sphere.renderOrder = 1000;
        return sphere;
    };

    const createMeasureVisual = (measurement: Measurement): MeasureVisual => {
        const label = document.createElement('div');
        label.className = 'cad-measure-label';
        measureLabelLayer.appendChild(label);
        if (isMeasureSegment(measurement)) {
            const line = new THREE.Line(new THREE.BufferGeometry(), measureLineMaterial);
            setMeasureLinePoints(line, measurement.a, measurement.b);
            line.renderOrder = 999;
            const sphereA = makeMeasureSphere();
            sphereA.position.set(measurement.a[0], measurement.a[1], measurement.a[2]);
            const sphereB = makeMeasureSphere();
            sphereB.position.set(measurement.b[0], measurement.b[1], measurement.b[2]);
            label.textContent = formatMeasureDistance(measurement.distance, measurementDecimals.length);
            measureGroup.add(line, sphereA, sphereB);
            return { type: 'segment', measurement, line, sphereA, sphereB, label };
        }
        if (isMeasureAngle(measurement)) {
            // Segments BA and BC meeting at the vertex B.
            const lineBA = new THREE.Line(new THREE.BufferGeometry(), measureLineMaterial);
            setMeasureLinePoints(lineBA, measurement.b, measurement.a);
            lineBA.renderOrder = 999;
            const lineBC = new THREE.Line(new THREE.BufferGeometry(), measureLineMaterial);
            setMeasureLinePoints(lineBC, measurement.b, measurement.c);
            lineBC.renderOrder = 999;
            const sphereA = makeMeasureSphere();
            sphereA.position.set(measurement.a[0], measurement.a[1], measurement.a[2]);
            const sphereB = makeMeasureSphere();
            sphereB.position.set(measurement.b[0], measurement.b[1], measurement.b[2]);
            const sphereC = makeMeasureSphere();
            sphereC.position.set(measurement.c[0], measurement.c[1], measurement.c[2]);
            label.textContent = formatMeasureAngle(measurement.angle, measurementDecimals.angle);
            measureGroup.add(lineBA, lineBC, sphereA, sphereB, sphereC);
            return { type: 'angle', measurement, lineBA, lineBC, sphereA, sphereB, sphereC, label };
        }
        const sphereCenter = makeMeasureSphere();
        sphereCenter.position.set(measurement.center[0], measurement.center[1], measurement.center[2]);
        label.textContent = formatMeasureRadius(measurement.radius, measurementDecimals.length);
        measureGroup.add(sphereCenter);
        return { type: 'radius', measurement, sphereCenter, label };
    };

    const disposeMeasureVisual = (visual: MeasureVisual): void => {
        if (visual.type === 'segment') {
            visual.line.removeFromParent();
            visual.line.geometry.dispose();
            visual.sphereA.removeFromParent();
            visual.sphereB.removeFromParent();
        } else if (visual.type === 'angle') {
            visual.lineBA.removeFromParent();
            visual.lineBA.geometry.dispose();
            visual.lineBC.removeFromParent();
            visual.lineBC.geometry.dispose();
            visual.sphereA.removeFromParent();
            visual.sphereB.removeFromParent();
            visual.sphereC.removeFromParent();
        } else {
            visual.sphereCenter.removeFromParent();
        }
        visual.label.remove();
    };

    /** Refresh a reused visual's transforms and label after its state object changed. */
    const updateMeasureVisual = (visual: MeasureVisual, measurement: Measurement): void => {
        if (visual.type === 'segment' && isMeasureSegment(measurement)) {
            visual.measurement = measurement;
            setMeasureLinePoints(visual.line, measurement.a, measurement.b);
            visual.sphereA.position.set(measurement.a[0], measurement.a[1], measurement.a[2]);
            visual.sphereB.position.set(measurement.b[0], measurement.b[1], measurement.b[2]);
            visual.label.textContent = formatMeasureDistance(measurement.distance, measurementDecimals.length);
            return;
        }
        if (visual.type === 'angle' && isMeasureAngle(measurement)) {
            visual.measurement = measurement;
            setMeasureLinePoints(visual.lineBA, measurement.b, measurement.a);
            setMeasureLinePoints(visual.lineBC, measurement.b, measurement.c);
            visual.sphereA.position.set(measurement.a[0], measurement.a[1], measurement.a[2]);
            visual.sphereB.position.set(measurement.b[0], measurement.b[1], measurement.b[2]);
            visual.sphereC.position.set(measurement.c[0], measurement.c[1], measurement.c[2]);
            visual.label.textContent = formatMeasureAngle(measurement.angle, measurementDecimals.angle);
            return;
        }
        if (visual.type === 'radius' && isMeasureRadius(measurement)) {
            visual.measurement = measurement;
            visual.sphereCenter.position.set(measurement.center[0], measurement.center[1], measurement.center[2]);
            visual.label.textContent = formatMeasureRadius(measurement.radius, measurementDecimals.length);
        }
    };

    /** Reconcile the overlay objects with the pushed state (called per state change, not per frame). */
    const syncMeasureObjects = (): void => {
        const modeMeasurements = measureState.measurements.filter((measurement) => measurement.kind === measureState.mode);
        const presentIds = new Set(modeMeasurements.map((measurement) => measurement.id));
        for (const [id, visual] of [...measureVisuals]) {
            if (!presentIds.has(id)) {
                disposeMeasureVisual(visual);
                measureVisuals.delete(id);
            }
        }
        for (const measurement of modeMeasurements) {
            const existing = measureVisuals.get(measurement.id);
            if (existing === undefined) {
                measureVisuals.set(measurement.id, createMeasureVisual(measurement));
            } else if (existing.measurement !== measurement) {
                updateMeasureVisual(existing, measurement);
            }
        }
        const hasPending = measureState.active && measureState.pending !== undefined;
        const hasVertex = measureState.active && measureState.pendingVertex !== undefined;
        pendingLine.visible = false;
        pendingMarker.visible = false;
        pendingVertexMarker.visible = false;
        pendingLabel.style.display = 'none';
        if (hasPending) {
            const pendingPoint = measureState.pending as MeasurePoint3D;
            pendingMarker.position.set(pendingPoint[0], pendingPoint[1], pendingPoint[2]);
            pendingMarker.visible = true;
            if (hasVertex) {
                const vertexPoint = measureState.pendingVertex as MeasurePoint3D;
                pendingVertexMarker.position.set(vertexPoint[0], vertexPoint[1], vertexPoint[2]);
                pendingVertexMarker.visible = true;
            }
            if (measureHover !== undefined) {
                // Preview from the most recent pick: B→hover once the vertex is
                // set, otherwise A→hover.
                const anchor = hasVertex ? (measureState.pendingVertex as MeasurePoint3D) : pendingPoint;
                setMeasureLinePoints(pendingLine, anchor, measureHover);
                pendingLine.visible = true;
            }
        }
        measureGroup.visible = measureState.active || modeMeasurements.length > 0;
        measureLabelLayer.style.display = measureGroup.visible ? '' : 'none';
    };

    const measureViewProjection = new THREE.Matrix4();
    const updateMeasureOverlays = (): void => {
        if (!measureGroup.visible) {
            return;
        }
        const cam = controller.getActiveCamera();
        const rectWidth = container.clientWidth || 1;
        const rectHeight = container.clientHeight || 1;
        const viewProjection = measureViewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
        const isOrtho = (cam as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
        const markerScaleFor = (anchor: MeasurePoint3D): number => {
            if (isOrtho) {
                const ortho = cam as THREE.OrthographicCamera;
                return MEASURE_MARKER_PX / Math.max(rectHeight / Math.max(ortho.top - ortho.bottom, 1e-9), 1e-9);
            }
            const perspective = cam as THREE.PerspectiveCamera;
            const distance = Math.max(camera.position.distanceTo(new THREE.Vector3(anchor[0], anchor[1], anchor[2])), 1e-6);
            const pxPerUnit = rectHeight / (2 * Math.tan(((perspective.fov ?? 45) * Math.PI) / 360) * distance);
            return MEASURE_MARKER_PX / Math.max(pxPerUnit, 1e-9);
        };
        const positionLabel = (label: HTMLDivElement, anchor: MeasurePoint3D, text: string): { x: number; y: number } | undefined => {
            const screen = projectMeasurePoint(anchor, viewProjection, rectWidth, rectHeight);
            label.textContent = text;
            label.style.display = screen.visible ? '' : 'none';
            if (!screen.visible) {
                return undefined;
            }
            return { x: screen.x, y: screen.y };
        };
        const scaleSphere = (sphere: THREE.Mesh, point: MeasurePoint3D): void => {
            const screen = projectMeasurePoint(point, viewProjection, rectWidth, rectHeight);
            sphere.visible = screen.visible;
            const scale = markerScaleFor(point);
            sphere.scale.set(scale, scale, scale);
        };
        // Pass 1: set text, project anchors, hide labels behind the camera, and
        // collect visible candidates with their measured box sizes.
        const labelCandidates: MeasureLabelCandidate[] = [];
        for (const visual of measureVisuals.values()) {
            let anchor: MeasurePoint3D;
            let text: string;
            if (visual.type === 'segment') {
                anchor = visual.measurement.midpoint;
                text = formatMeasureDistance(visual.measurement.distance, measurementDecimals.length);
            } else if (visual.type === 'angle') {
                anchor = visual.measurement.b;
                text = formatMeasureAngle(visual.measurement.angle, measurementDecimals.angle);
            } else {
                anchor = visual.measurement.center;
                text = formatMeasureRadius(visual.measurement.radius, measurementDecimals.length);
            }
            const screen = positionLabel(visual.label, anchor, text);
            if (screen !== undefined) {
                labelCandidates.push({
                    id: visual.measurement.id,
                    x: screen.x,
                    y: screen.y,
                    width: visual.label.offsetWidth || 64,
                    height: visual.label.offsetHeight || 18
                });
            }
        }
        // Pass 2: clamp to the viewport and stack colliding labels apart,
        // deterministic in measurement order.
        const labelPlacements = layoutMeasureLabels(labelCandidates, rectWidth, rectHeight);
        for (const visual of measureVisuals.values()) {
            const placement = labelPlacements.get(visual.measurement.id);
            if (placement !== undefined) {
                visual.label.style.left = `${placement.x}px`;
                visual.label.style.top = `${placement.y}px`;
            }
        }
        for (const visual of measureVisuals.values()) {
            if (visual.type === 'segment') {
                scaleSphere(visual.sphereA, visual.measurement.a);
                scaleSphere(visual.sphereB, visual.measurement.b);
            } else if (visual.type === 'angle') {
                scaleSphere(visual.sphereA, visual.measurement.a);
                scaleSphere(visual.sphereB, visual.measurement.b);
                scaleSphere(visual.sphereC, visual.measurement.c);
            } else {
                scaleSphere(visual.sphereCenter, visual.measurement.center);
            }
        }
        if (measureState.active && measureState.pending !== undefined) {
            const pendingPoint = measureState.pending as MeasurePoint3D;
            const vertex = measureState.pendingVertex;
            const pendingScreen =
                measureState.tool === 'angle' && vertex !== undefined && measureHover !== undefined
                    ? // Live angle preview at the vertex while the third point hovers.
                      positionLabel(
                          pendingLabel,
                          vertex,
                          formatMeasureAngle(measureAngle(pendingPoint, vertex, measureHover), measurementDecimals.angle)
                      )
                    : positionLabel(
                          pendingLabel,
                          measureHover ?? pendingPoint,
                          measureHover !== undefined && measureState.tool === 'distance'
                              ? formatMeasureDistance(measureDistance(pendingPoint, measureHover), measurementDecimals.length)
                              : measureState.tool === 'radius'
                                ? 'Pick a circular edge'
                                : vertex !== undefined
                                  ? 'Pick third point'
                                  : measureState.tool === 'angle'
                                    ? 'Pick vertex (point B)'
                                    : 'Pick second point'
                      );
            if (pendingScreen !== undefined) {
                // Transient hint: clamp inside the viewport (no collision pass).
                const clamped = clampMeasureLabel(
                    pendingScreen.x,
                    pendingScreen.y,
                    pendingLabel.offsetWidth || 64,
                    pendingLabel.offsetHeight || 18,
                    rectWidth,
                    rectHeight
                );
                pendingLabel.style.left = `${clamped.x}px`;
                pendingLabel.style.top = `${clamped.y}px`;
            }
            const scale = markerScaleFor(pendingPoint);
            pendingMarker.scale.set(scale, scale, scale);
            if (vertex !== undefined) {
                const vertexScale = markerScaleFor(vertex);
                pendingVertexMarker.scale.set(vertexScale, vertexScale, vertexScale);
            }
        }
    };

    let controller: SketchModeController;
    const renderScene = (): void => {
        const cam = controller.getActiveCamera();
        // World-origin axes are document-mode chrome that need a loaded model:
        // a sketch session hides the group, and an empty viewport (no document
        // or an empty/reset document with no tessellation) never shows it.
        const hasLoadedModel = currentTessData !== undefined && meshes.length > 0;
        originAxesGroup.visible = originAxesEnabled && hasLoadedModel && !controller.isActive && !originAxesSuppressed;
        // Clip planes follow the scene scale on every render (build, fit,
        // dolly, orbit, zoom): a fixed far plane clips any model larger than
        // ~5.8 km (the tokamak's 6.4 km diagonal) and a fixed 1e6 near/far
        // ratio z-fights concentric shells. Sketch mode keeps its own ortho
        // frustum, so only the perspective model camera is re-fit.
        if (cam === camera) {
            const clip = computeClipPlanes(camera.position.distanceTo(controls.target), lastDiag / 2);
            if (camera.near !== clip.near || camera.far !== clip.far) {
                camera.near = clip.near;
                camera.far = clip.far;
                camera.updateProjectionMatrix();
            }
        }
        // Camera matrices must be fresh before the overlay projection math, and
        // the overlays must be updated BEFORE the paint: with render-on-demand
        // there is no next frame to correct a stale one, so painting first would
        // flash newly created measure markers at their initial unit scale.
        cam.updateMatrixWorld();
        updateMeasureOverlays();
        renderer.render(scene, cam);
        updateViewCube();
    };
    controller = new SketchModeController(container, scene, renderer, controls, renderScene, {
        modelGroup,
        messageService,
        documentStore,
        mainCamera: camera
    });
    onControllerReady(controller, camera);

    const setOriginAxes = (axes: OriginAxesVisibility, suppressed = false): void => {
        originAxesEnabled = axes.enabled;
        originAxesSuppressed = suppressed;
        originAxisLines[0].visible = axes.x;
        originAxisLines[1].visible = axes.y;
        originAxisLines[2].visible = axes.z;
        renderScene();
    };
    setOriginAxes(initialOriginAxes);

    const applyCurveHighlight = (): void => {
        for (const line of curveLines) {
            const id = line.userData.curveId;
            const highlighted = id === selectedCurveId || id === curvePickHoverId;
            const material = highlighted ? curveLineHighlightMaterial : curveLineMaterial;
            if (line.material !== material) {
                line.material = material;
            }
        }
    };

    const applyHighlight = (): void => {
        bodyMaterial.color.copy(baseColor);
        highlightMaterial.color.copy(selectedColor);
        const highlightIds = currentSelection.solidIds ?? (currentSelection.solidId !== undefined ? [currentSelection.solidId] : []);
        for (const mesh of meshes) {
            const data = mesh.userData;
            // A selection with only a solidId (outline-panel row click) highlights
            // every face of the solid; a viewport pick stays face-precise.
            const isSelected =
                highlightIds.includes(data.solidId as number) &&
                (currentSelection.faceId === undefined || data.faceId === currentSelection.faceId);
            // Selection always uses the shared highlight material; otherwise an
            // overridden body renders with its private appearance material.
            const material = isSelected ? highlightMaterial : (appearanceMaterial(data.bodyId) ?? bodyMaterial);
            if (mesh.material !== material) {
                mesh.material = material;
            }
        }
        applyCurveHighlight();
        renderScene();
    };

    // Single source of truth for all material fiddling: shading-mode changes,
    // ghost-opacity changes, section changes, and fresh rebuilds funnel through
    // here so the active mode, opacity, and clipping plane survive model rebuilds.
    const computeSectionPlanes = (): THREE.Plane[] | null => {
        if (activeSection === undefined || currentTessData === undefined) {
            return null;
        }
        const plane = sectionPlaneFromBox(activeSection, currentTessData.boundingBox);
        return [new THREE.Plane(new THREE.Vector3(...plane.normal), plane.constant)];
    };
    const applyShading = (): void => {
        const clippingPlanes = computeSectionPlanes();
        const flags = meshShadingFlags(shading, ghostOpacity);
        // Flags are role-wide: bodies without overrides share the two core
        // materials, so the shading mode lands on the materials directly;
        // per-mesh state is visibility only (plus hidden solids).
        for (const material of [bodyMaterial, highlightMaterial]) {
            material.wireframe = flags.wireframe;
            material.transparent = flags.transparent;
            material.opacity = flags.opacity;
            material.depthWrite = flags.depthWrite;
            material.clippingPlanes = clippingPlanes;
            material.needsUpdate = true;
        }
        // Per-body appearance materials follow the same flags, except that a
        // body opacity applies in `shaded` mode only: x-ray/ghost opacity wins,
        // and shaded-wireframe/edges-only keep full opacity (edges stay
        // readable over a translucent solid).
        for (const entry of bodyAppearanceMaterials.values()) {
            const material = entry.material;
            const appearanceOpacity = shading === 'shaded' ? entry.opacity : undefined;
            material.wireframe = flags.wireframe;
            material.transparent = appearanceOpacity !== undefined ? appearanceOpacity < 1 : flags.transparent;
            material.opacity = appearanceOpacity ?? flags.opacity;
            material.depthWrite = appearanceOpacity !== undefined && appearanceOpacity < 1 ? false : flags.depthWrite;
            material.clippingPlanes = clippingPlanes;
            material.needsUpdate = true;
        }
        for (const mesh of meshes) {
            mesh.visible = flags.faceVisible && !hiddenSolidIds.has(mesh.userData.solidId as number);
        }
        for (const line of edgeLines) {
            line.visible = !hiddenSolidIds.has(line.userData.solidId as number);
        }
        applyCurveVisibility();
        edgeLineMaterial.clippingPlanes = clippingPlanes;
        edgeLineMaterial.needsUpdate = true;
        applyHighlight();
    };

    /**
     * Sweep/pipe path consumptions behind the current document: which body
     * each curve builds. Suppressed features build nothing, so they never
     * keep a curve visible.
     */
    const collectCurvePathUsers = (): CurvePathUser[] => {
        const users: CurvePathUser[] = [];
        for (const feature of documentStore.document?.features ?? []) {
            if ((feature.type === 'sweep' || feature.type === 'pipe') && !feature.suppressed) {
                const pathCurveId = (feature.params as Record<string, unknown>).pathCurveId;
                if (typeof pathCurveId === 'string' && pathCurveId.length > 0) {
                    users.push({ curveId: pathCurveId, bodyId: feature.body });
                }
            }
        }
        return users;
    };

    /**
     * Curves are construction geometry with no solid of their own: a curve
     * hides exactly when every body consuming it as a sweep/pipe path is
     * fully hidden (hiding copper must not leave its centerline floating in
     * an empty viewport). Runs inside `applyShading`, so every visibility
     * funnel — rebuilds, hidden-set changes, shading/section switches —
     * keeps curves in sync.
     */
    const applyCurveVisibility = (): void => {
        const solidToBody = new Map<number, string>();
        for (const mesh of meshes) {
            if (typeof mesh.userData.bodyId === 'string') {
                solidToBody.set(mesh.userData.solidId as number, mesh.userData.bodyId);
            }
        }
        const visible = visibleCurveIds(
            curveLines.map((line) => line.userData.curveId as string),
            collectCurvePathUsers(),
            solidToBody,
            hiddenSolidIds
        );
        for (const line of curveLines) {
            line.visible = visible.has(line.userData.curveId as string);
        }
    };

    /**
     * Raycast targets that respect the current shading mode and the hidden
     * solids set: three.js renders invisible objects never, but its raycaster
     * still hits them, so picking must filter explicitly.
     */
    const pickableMeshes = (): THREE.Mesh[] =>
        shading === 'edgesOnly' ? [] : meshes.filter((mesh) => !hiddenSolidIds.has(mesh.userData.solidId as number));
    const pickableEdgeLines = (): THREE.Line[] => edgeLines.filter((line) => !hiddenSolidIds.has(line.userData.solidId as number));
    /** Hidden curves are invisible but still raycastable — filter explicitly. */
    const pickableCurveLines = (): THREE.Line[] => curveLines.filter((line) => line.visible);

    /**
     * Face meshes pooled by content-based reuse key across rebuilds. Unchanged
     * faces keep their BufferGeometry between rebuilds; only added faces pay
     * geometry construction. The pool always mirrors `previousTessData` exactly
     * (one mesh per face entry), which is what {@link planFaceReuse} plans
     * against.
     */
    let meshPool = new Map<string, THREE.Mesh[]>();
    let previousTessData: TessData | undefined;

    const disposePooledMeshes = (): void => {
        for (const bucket of meshPool.values()) {
            for (const mesh of bucket) {
                modelGroup.remove(mesh);
                for (const group of instanceGroups) {
                    group.remove(mesh);
                }
                mesh.geometry.dispose();
            }
        }
        meshPool = new Map();
        meshes = [];
        for (const group of instanceGroups) {
            modelGroup.remove(group);
        }
        instanceGroups = [];
    };

    /**
     * Per-instance scene groups (Wave B2). Each assembly instance gets a
     * `THREE.Group` carrying its solved Mat4; meshes keep shared
     * BufferGeometry (see `shareAssemblyGeometries`) and per-instance
     * `userData = { instanceId, solidId, faceId }`. Single-part payloads
     * (no `instanceId` on any face) render exactly as before, with meshes
     * parented directly to the model group.
     */
    let instanceGroups: THREE.Group[] = [];

    const applyInstanceGroups = (): void => {
        for (const group of instanceGroups) {
            modelGroup.remove(group);
        }
        instanceGroups = [];
        for (const mesh of meshes) {
            modelGroup.remove(mesh);
        }
        const assembly = documentStore.document !== undefined ? getAssemblySection(documentStore.document) : undefined;
        let transforms: Map<string, import('../../../common/assembly-document').Mat4> | undefined;
        if (assembly !== undefined) {
            try {
                transforms = solveAssemblyTransforms(assembly);
            } catch {
                transforms = undefined;
            }
        }
        const groups = new Map<string, THREE.Group>();
        for (const mesh of meshes) {
            const instanceId = mesh.userData.instanceId as string | undefined;
            if (typeof instanceId !== 'string' || instanceId === '' || transforms === undefined) {
                modelGroup.add(mesh);
                continue;
            }
            let group = groups.get(instanceId);
            if (group === undefined) {
                group = new THREE.Group();
                group.name = `cad-instance-${instanceId}`;
                const matrix = transforms.get(instanceId);
                if (matrix !== undefined) {
                    // Row-major Mat4 → three.js column-major Matrix4.
                    group.matrixAutoUpdate = false;
                    group.matrix.set(
                        matrix[0],
                        matrix[1],
                        matrix[2],
                        matrix[3],
                        matrix[4],
                        matrix[5],
                        matrix[6],
                        matrix[7],
                        matrix[8],
                        matrix[9],
                        matrix[10],
                        matrix[11],
                        matrix[12],
                        matrix[13],
                        matrix[14],
                        matrix[15]
                    );
                }
                modelGroup.add(group);
                groups.set(instanceId, group);
                instanceGroups.push(group);
            }
            group.add(mesh);
        }
    };

    /**
     * Share one BufferGeometry per source face across instances: meshes whose
     * `<sourcePart>#<bodyId>::<faceFingerprint>` key matches reuse the first
     * mesh's geometry (the reuse pool already shares across rebuilds; this
     * shares within a build across instance groups).
     */
    const shareAssemblyGeometries = (liveMeshes: THREE.Mesh[]): void => {
        const assembly = documentStore.document !== undefined ? getAssemblySection(documentStore.document) : undefined;
        if (assembly === undefined) {
            return;
        }
        const partByInstance = new Map(assembly.instances.map((i) => [i.id, i.part]));
        const shared = new Map<string, THREE.BufferGeometry>();
        for (const mesh of liveMeshes) {
            const instanceId = mesh.userData.instanceId as string | undefined;
            if (typeof instanceId !== 'string' || instanceId === '') {
                continue;
            }
            const part = partByInstance.get(instanceId) ?? instanceId;
            const key = `${part}#${(mesh.userData.bodyId as string | undefined) ?? ''}::${mesh.userData.reuseKey as string}`;
            const existing = shared.get(key);
            if (existing !== undefined && existing !== mesh.geometry) {
                mesh.geometry.dispose();
                mesh.geometry = existing;
            } else {
                shared.set(key, mesh.geometry);
            }
        }
    };

    /**
     * Vertex-average approximation of each solid's centroid, one pass over the
     * tessellated coordinates. Only the explode direction derives from it, so
     * the vertex average suffices (exact volume centroids would need an
     * area-weighted pass over every triangle).
     */
    const computeExplodeCentroids = (data: TessData): ExplodeSolidCentroid[] => {
        const sums = new Map<number, [number, number, number, number]>();
        for (const face of data.faces) {
            let entry = sums.get(face.solidId);
            if (entry === undefined) {
                entry = [0, 0, 0, 0];
                sums.set(face.solidId, entry);
            }
            for (let i = 0; i < face.positions.length; i += 3) {
                entry[0] += face.positions[i];
                entry[1] += face.positions[i + 1];
                entry[2] += face.positions[i + 2];
            }
            entry[3] += face.positions.length / 3;
        }
        const solids: ExplodeSolidCentroid[] = [];
        for (const [solidId, entry] of sums) {
            solids.push({
                solidId,
                centroid: entry[3] > 0 ? [entry[0] / entry[3], entry[1] / entry[3], entry[2] / entry[3]] : [0, 0, 0]
            });
        }
        return solids;
    };

    /**
     * Apply the explode offsets as object positions (faces AND the edge lines
     * of the same solid move together; document-level curve lines carry no
     * solid id and stay pinned at the origin so reused pooled state can never
     * strand them). Raycast picking uses world matrices, so it keeps working
     * on exploded geometry. Factor 0 resets every transform to the origin —
     * reused pooled meshes may carry a stale position from a previous explode,
     * so the zero write is unconditional.
     */
    const applyExplode = (): void => {
        if (explodeFactor <= 0 || currentTessData === undefined) {
            for (const mesh of meshes) {
                mesh.position.set(0, 0, 0);
            }
            for (const line of edgeLines) {
                line.position.set(0, 0, 0);
            }
            for (const line of curveLines) {
                line.position.set(0, 0, 0);
            }
            return;
        }
        if (explodeCentroids === undefined) {
            explodeCentroids = computeExplodeCentroids(currentTessData);
        }
        const offsets = planExplodeOffsets(explodeCentroids, currentTessData.boundingBox, explodeFactor);
        for (const mesh of meshes) {
            const offset = offsets.get(mesh.userData.solidId as number);
            mesh.position.set(offset?.[0] ?? 0, offset?.[1] ?? 0, offset?.[2] ?? 0);
        }
        for (const line of edgeLines) {
            const offset = offsets.get(line.userData.solidId as number);
            line.position.set(offset?.[0] ?? 0, offset?.[1] ?? 0, offset?.[2] ?? 0);
        }
        for (const line of curveLines) {
            line.position.set(0, 0, 0);
        }
    };

    // Right-click overlays anchored over the canvas. Their contents reference
    // scene meshes, so a model change (or unmount) must dismiss them. The
    // candidate list is captured from the last context-menu raycast for the
    // Select Other action and cleared whenever the menu is dismissed.
    let closeContextMenu: (() => void) | undefined;
    let closeSelectOtherMenu: (() => void) | undefined;
    let contextMenuCandidates: readonly FacePickCandidate[] = [];
    const closeViewportOverlays = (): void => {
        closeContextMenu?.();
        closeContextMenu = undefined;
        closeSelectOtherMenu?.();
        closeSelectOtherMenu = undefined;
        contextMenuCandidates = [];
    };

    const buildModel = (data?: TessData): void => {
        closeViewportOverlays();
        const t0 = PROFILE_TESSELLATION_LOAD ? performance.now() : 0;
        currentTessData = data;
        // Edge lines and curves are small (profiled ~50 ms at tokamak scale
        // vs ~830 ms parse) — they keep the full teardown-rebuild discipline.
        for (const line of edgeLines) {
            modelGroup.remove(line);
            line.geometry.dispose();
        }
        edgeLines = [];
        for (const line of curveLines) {
            modelGroup.remove(line);
            line.geometry.dispose();
        }
        curveLines = [];
        faceHighlighter.clear();
        edgeHighlighter.clear();

        if (data === undefined) {
            previousTessData = undefined;
            disposePooledMeshes();
            disposeBodyAppearanceMaterials();
            explodeCentroids = undefined;
            applyOriginAxesLength(5);
            applyExplode();
            applyShading();
            return;
        }

        const bbox = data.boundingBox;
        const center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
        const diag = new THREE.Vector3(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]).length();
        lastCenter.copy(center);
        lastDiag = diag;
        applyOriginAxesLength(Math.max(lastDiag * 0.08, 1));
        camera.position.copy(center.clone().add(new THREE.Vector3(diag, diag, diag)));
        camera.lookAt(center);
        controls.target.copy(center);
        controls.update();

        const plan = planFaceReuse(previousTessData, data);
        previousTessData = data;
        const nextMeshes: THREE.Mesh[] = [];
        const nextPool = new Map<string, THREE.Mesh[]>();
        const adopt = (mesh: THREE.Mesh, key: string): void => {
            modelGroup.add(mesh);
            nextMeshes.push(mesh);
            const bucket = nextPool.get(key);
            if (bucket === undefined) {
                nextPool.set(key, [mesh]);
            } else {
                bucket.push(mesh);
            }
        };
        for (const { key, face } of plan.reused) {
            // The plan guarantees a pooled mesh exists for every reused key.
            const mesh = meshPool.get(key)?.pop() as THREE.Mesh;
            // Solid identity is positional and can shuffle between builds, so
            // userData is re-derived from the new payload even for reused
            // geometry (picking/outline maps read these fields).
            mesh.userData = {
                reuseKey: key,
                solidId: face.solidId,
                faceId: face.faceId,
                bodyId: face.bodyId,
                instanceId: face.instanceId,
                fingerprint: face.fingerprint
            };
            adopt(mesh, key);
        }
        for (const face of plan.added) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(face.positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(face.indices, 1));
            geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, bodyMaterial);
            const key = faceReuseKey(face);
            mesh.userData = {
                reuseKey: key,
                solidId: face.solidId,
                faceId: face.faceId,
                bodyId: face.bodyId,
                instanceId: face.instanceId,
                fingerprint: face.fingerprint
            };
            adopt(mesh, key);
        }
        // Shared BufferGeometry across instances: faces of one source face
        // (same `<sourcePart>#<bodyId>::<faceFingerprint>` key) reference a
        // single geometry even when rendered in different instance groups.
        shareAssemblyGeometries(nextMeshes);
        // Leftover pooled meshes served faces that vanished from the payload.
        // Their geometries may now be shared with live meshes — only dispose
        // unreferenced ones.
        const liveGeometries = new Set<THREE.BufferGeometry>(nextMeshes.map((mesh) => mesh.geometry));
        for (const bucket of meshPool.values()) {
            for (const mesh of bucket) {
                modelGroup.remove(mesh);
                for (const group of instanceGroups) {
                    group.remove(mesh);
                }
                if (!liveGeometries.has(mesh.geometry)) {
                    mesh.geometry.dispose();
                }
            }
        }
        meshPool = nextPool;
        meshes = nextMeshes;
        applyInstanceGroups();
        // Appearance overrides are document state; re-derive them for every
        // build (materials survive across rebuilds when overrides are equal).
        syncBodyAppearances();

        for (const edge of data.edges) {
            const line = buildEdgeLine(edge.solidId, edge, edgeLineMaterial);
            modelGroup.add(line);
            edgeLines.push(line);
        }
        for (const curve of data.curves) {
            const line = buildCurveLine(curve, curveLineMaterial);
            modelGroup.add(line);
            curveLines.push(line);
        }
        explodeCentroids = undefined;
        applyExplode();
        applyShading();
        applyCurveHighlight();
        if (PROFILE_TESSELLATION_LOAD) {
            console.log(
                `[CadViewport] profile: buildModel ${(performance.now() - t0).toFixed(0)} ms (reused ${plan.reused.length}, added ${plan.added.length}, disposed ${plan.removedKeys.length})`
            );
        }
    };

    buildModel(tessData);

    /**
     * Replace the ghosted preview solids. Faces only (no edge lines) — the
     * preview is a shape hint on top of the live model, rendered at the ghost
     * (x-ray) opacity in a dedicated group the model rebuild never touches.
     */
    const setPreviewTessellation = (data?: TessData): void => {
        for (const mesh of previewMeshes) {
            previewGroup.remove(mesh);
            mesh.geometry.dispose();
        }
        previewMeshes = [];
        if (data === undefined) {
            renderScene();
            return;
        }
        for (const face of data.faces) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(face.positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(face.indices, 1));
            geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, previewGhostMaterial);
            previewGroup.add(mesh);
            previewMeshes.push(mesh);
        }
        renderScene();
    };

    /** Fit the camera to one solid's bounding box along the current view direction. */
    const fitToSolid = (solidId: number): void => {
        const box = new THREE.Box3();
        let found = false;
        // Instance groups carry the solved Mat4 on the parent; refresh world
        // matrices so per-instance framing uses posed geometry.
        modelGroup.updateMatrixWorld(true);
        for (const mesh of meshes) {
            if (mesh.userData.solidId !== solidId) {
                continue;
            }
            if (mesh.geometry.boundingBox === null) {
                mesh.geometry.computeBoundingBox();
            }
            box.expandByObject(mesh);
            found = true;
        }
        if (!found) {
            return;
        }
        const center = box.getCenter(new THREE.Vector3());
        const diag = box.getSize(new THREE.Vector3()).length();
        const direction = camera.position.clone().sub(controls.target);
        if (direction.length() < 1e-6) {
            direction.set(1, -1, 1);
        }
        camera.position.copy(
            direction
                .normalize()
                .multiplyScalar(diag * 1.75)
                .add(center)
        );
        controls.target.copy(center);
        camera.lookAt(center);
        controls.update();
        renderScene();
    };

    /** Fit the whole model along the current view direction, ignoring selection. */
    const fitAllView = (): void => {
        const direction = camera.position.clone().sub(controls.target);
        if (direction.length() < 1e-6) {
            direction.set(1, -1, 1);
        }
        direction
            .normalize()
            .multiplyScalar(lastDiag * 1.75)
            .add(lastCenter);
        camera.position.copy(direction);
        controls.target.copy(lastCenter);
        camera.lookAt(lastCenter);
        controls.update();
        renderScene();
    };

    const fitView = (): void => {
        if (currentSelection.solidId !== undefined) {
            fitToSolid(currentSelection.solidId);
            return;
        }
        fitAllView();
    };

    const zoomView = (factor: number): void => {
        const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
        camera.position.copy(controls.target).add(offset);
        controls.update();
        renderScene();
    };

    const VIEW_UP_Z = new THREE.Vector3(0, 0, 1);
    const VIEW_UP_Y = new THREE.Vector3(0, 1, 0);
    let controlsUp = VIEW_UP_Z.clone();
    // OrbitControls freezes its orbit pole from camera.up at construction, so
    // a view snap that needs a different up re-creates the controls instead of
    // leaving the camera stranded on the old pole with dead orbit directions.
    const recreateControls = (up: THREE.Vector3): void => {
        controls.dispose();
        camera.up.copy(up);
        controlsUp = up.clone();
        controls = new OrbitControlsCtor(camera, renderer.domElement);
        applyNavigationStyle(controls, navigationStyle);
        controls.target.copy(lastCenter);
        controls.addEventListener('change', renderScene);
        controls.addEventListener('start', onViewInteractionStart);
        applyControlsEnabled();
        controls.update();
    };

    const setViewDirection = (dir: readonly [number, number, number]): void => {
        onViewNameChange(viewNameForDirection(dir));
        const viewDir = new THREE.Vector3(...dir).normalize();
        camera.position.copy(
            viewDir
                .clone()
                .multiplyScalar(lastDiag * 1.75)
                .add(lastCenter)
        );
        // Top/bottom views look straight down the Z orbit pole; they re-pole
        // the controls around Y (map-style) so mouse orbiting stays live.
        const desiredUp = Math.abs(viewDir.z) > 0.999 ? VIEW_UP_Y : VIEW_UP_Z;
        if (!controlsUp.equals(desiredUp)) {
            recreateControls(desiredUp);
        }
        camera.up.copy(desiredUp);
        controls.target.copy(lastCenter);
        camera.lookAt(lastCenter);
        controls.update();
        renderScene();
    };

    const setStandardView = (view: 'iso' | 'top' | 'front' | 'right'): void => {
        const directions: Record<'iso' | 'top' | 'front' | 'right', [number, number, number]> = {
            iso: [1, -1, 1],
            top: [0, 0, 1],
            front: [0, -1, 0],
            right: [1, 0, 0]
        };
        setViewDirection(directions[view]);
    };

    /** Snapshot the live camera pose for a saved named view. */
    const getCameraState = (): CadCameraState => ({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
        up: [camera.up.x, camera.up.y, camera.up.z]
    });

    /**
     * Restore a saved camera pose (no distance clamping).
     *
     * Position and target are copied verbatim and `up` is normalized.
     * Non-finite vectors are ignored; a zero up vector is ignored too because
     * `lookAt`/OrbitControls would turn it into NaNs. A different up re-creates
     * the controls for the same reason the standard-view snap does
     * (OrbitControls freezes its orbit pole at construction).
     */
    const setCameraState = (state: CadCameraState): void => {
        const candidate = state as CadCameraState | undefined;
        if (
            candidate === undefined ||
            !isFiniteCameraVector(candidate.position) ||
            !isFiniteCameraVector(candidate.target) ||
            !isFiniteCameraVector(candidate.up)
        ) {
            return;
        }
        const desiredUp = new THREE.Vector3(...candidate.up);
        if (desiredUp.lengthSq() === 0) {
            return;
        }
        desiredUp.normalize();
        if (!controlsUp.equals(desiredUp)) {
            recreateControls(desiredUp);
        }
        const target = new THREE.Vector3(...candidate.target);
        camera.up.copy(desiredUp);
        camera.position.set(...candidate.position);
        controls.target.copy(target);
        camera.lookAt(target);
        // The restored pose is arbitrary, never one of the labeled standards.
        onViewNameChange('User');
        controls.update();
        renderScene();
    };

    const setShading = (mode: ShadingMode): void => {
        shading = mode;
        applyShading();
    };
    /**
     * Preference change: re-derive the per-body overrides (material colors
     * appear or disappear; explicit appearance colors and opacity carry over
     * unchanged) and re-apply shading so live meshes swap assignments. No
     * document mutation, no rebuild.
     */
    const setColorByMaterial = (enabled: boolean): void => {
        colorByMaterial = enabled;
        syncBodyAppearances();
        applyShading();
    };
    const setGhostOpacity = (value: number): void => {
        ghostOpacity = clampGhostOpacity(value);
        previewGhostMaterial.opacity = ghostOpacity;
        applyShading();
    };
    const setSection = (section?: SectionState): void => {
        activeSection = section ?? undefined;
        applyShading();
    };
    /** Preference change: swap the backdrop without rebuilding the scene. */
    const setViewportBackground = (style: ViewportBackgroundStyle): void => {
        backgroundStyle = style;
        applyBackground();
        renderScene();
    };
    /** Preference change: swap the mouse/touch bindings on the live controls. */
    const setNavigationStyle = (style: NavigationStyle): void => {
        navigationStyle = style;
        applyNavigationStyle(controls, navigationStyle);
        renderScene();
    };

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(10, 10, 10);
    scene.add(directional);

    // Render on demand: the scene is static unless the user orbits, the
    // selection changes, the theme changes, or the container resizes. No
    // animation loop runs while the widget is idle, hidden, or detached.
    controls.addEventListener('change', renderScene);
    // Any manual orbit/zoom/pan leaves the standard views; the badge picks the
    // change up on the next render (OrbitControls fires 'change' throughout).
    const onViewInteractionStart = (): void => {
        onViewNameChange('User');
    };
    controls.addEventListener('start', onViewInteractionStart);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    /** Extract an edge line's polyline as model-unit points for the radius fit. */
    const lineGeometryPoints = (line: THREE.Line): MeasurePoint3D[] => {
        const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (attribute === undefined) {
            return [];
        }
        const points: MeasurePoint3D[] = [];
        for (let i = 0; i < attribute.count; i++) {
            points.push([attribute.getX(i), attribute.getY(i), attribute.getZ(i)]);
        }
        return points;
    };

    /**
     * Map a pointer position to a point on the sketch plane for measurement,
     * mirroring SketchModeController's pointer mapping and reusing the active
     * session's snap settings through its public accessors.
     */
    const measureSketchPoint = (clientX: number, clientY: number): MeasurePoint3D | undefined => {
        const plane = controller.getDatumPlane();
        const cam = controller.getActiveCamera();
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = pointerToNdc(clientX, clientY, rect);
        const origin = new THREE.Vector3(ndc.x, ndc.y, -1).unproject(cam);
        const target = new THREE.Vector3(ndc.x, ndc.y, 1).unproject(cam);
        const direction = target.sub(origin).normalize();
        const hit = intersectRayPlane(
            { origin: { x: origin.x, y: origin.y, z: origin.z }, direction: { x: direction.x, y: direction.y, z: direction.z } },
            plane
        );
        if (hit === undefined) {
            return undefined;
        }
        const raw = worldToSketch(hit, plane);
        const ortho = cam as THREE.OrthographicCamera;
        const isOrtho = (ortho as unknown as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
        const orthoHeight = isOrtho ? ortho.top - ortho.bottom : defaultSketchViewSize();
        const radius = pixelRadiusToModelUnits(controller.getSnapRadiusPx(), orthoHeight, rect.height || 1);
        const snapped = snap(
            raw,
            controller.getSession()?.getPrimitives() ?? [],
            createSnapConfig({ enabled: controller.isSnapEnabled(), radius, gridPitch: 1 })
        );
        const world = sketchToWorld(snapped.point, plane);
        return [world.x, world.y, world.z];
    };

    /**
     * Nearest assembly connector of the picked face's instance to the hit
     * point (frames at solved poses). Returns undefined when the face carries
     * no instance attribution or the instance has no connectors — the caller
     * keeps the pick mode open so the user can click a part face.
     */
    const nearestConnectorToHit = (hit: FacePickHit): string | undefined => {
        const instanceId = (hit.mesh.userData as { instanceId?: unknown }).instanceId;
        if (typeof instanceId !== 'string' || hit.point === undefined) {
            return undefined;
        }
        const assembly = documentStore.document !== undefined ? getAssemblySection(documentStore.document) : undefined;
        if (assembly === undefined) {
            return undefined;
        }
        const candidates = assembly.connectors.filter((c) => c.instanceId === instanceId);
        if (candidates.length === 0) {
            return undefined;
        }
        let transforms: Map<string, import('../../../common/assembly-document').Mat4>;
        try {
            transforms = solveAssemblyTransforms(assembly);
        } catch {
            return undefined;
        }
        let best: string | undefined;
        let bestDistance = Infinity;
        for (const candidate of candidates) {
            const matrix = transforms.get(instanceId);
            if (matrix === undefined) {
                continue;
            }
            let frame: import('../../../common/assembly-placement').ConnectorFrame | undefined;
            try {
                frame = connectorFrameInAssembly(candidate, matrix);
            } catch {
                continue;
            }
            if (frame === undefined) {
                continue;
            }
            const distance = Math.hypot(frame.origin[0] - hit.point.x, frame.origin[1] - hit.point.y, frame.origin[2] - hit.point.z);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate.id;
            }
        }
        return best;
    };

    // Rubber-band box select: Ctrl/Cmd+drag draws a rectangle over the canvas
    // and adds every solid with a face-box center inside it to the selection.
    // Navigation is frozen while the modifier is held, so the drag never moves
    // the camera; a press-release without a drag falls through to the normal
    // click pick below. Inactive in sketch mode and every pick mode (those own
    // Ctrl+click), and while the measure tool captures clicks.
    const BOX_SELECT_MIN_PX = 5;
    const boxSelectBand = document.createElement('div');
    boxSelectBand.className = 'cad-box-select-band';
    boxSelectBand.style.display = 'none';
    container.appendChild(boxSelectBand);
    let boxSelectStart: { x: number; y: number } | undefined;
    let boxSelectDrawn = false;
    let suppressClickAfterBox = false;
    const boxSelectPickModesActive = (): boolean =>
        controller.isActive ||
        activeFacePickMode !== undefined ||
        activeDressUpPickMode !== undefined ||
        activeHolePickMode ||
        activeCurvePickMode ||
        activeDrawingDimensionPickMode ||
        activeConnectorPickMode ||
        measureState.active;
    const onBoxSelectPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || (!event.ctrlKey && !event.metaKey) || boxSelectPickModesActive()) {
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        boxSelectStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        boxSelectDrawn = false;
    };
    const onBoxSelectPointerMove = (event: PointerEvent): void => {
        if (boxSelectStart === undefined) {
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        if (!boxSelectDrawn) {
            if (Math.hypot(x - boxSelectStart.x, y - boxSelectStart.y) < BOX_SELECT_MIN_PX) {
                return;
            }
            boxSelectDrawn = true;
            boxSelectBand.style.display = '';
        }
        const containerRect = container.getBoundingClientRect();
        const offsetX = rect.left - containerRect.left;
        const offsetY = rect.top - containerRect.top;
        boxSelectBand.style.left = `${Math.min(boxSelectStart.x, x) + offsetX}px`;
        boxSelectBand.style.top = `${Math.min(boxSelectStart.y, y) + offsetY}px`;
        boxSelectBand.style.width = `${Math.abs(x - boxSelectStart.x)}px`;
        boxSelectBand.style.height = `${Math.abs(y - boxSelectStart.y)}px`;
    };
    const onBoxSelectPointerUp = (event: PointerEvent): void => {
        if (boxSelectStart === undefined) {
            return;
        }
        const start = boxSelectStart;
        boxSelectStart = undefined;
        if (!boxSelectDrawn) {
            return;
        }
        boxSelectDrawn = false;
        boxSelectBand.style.display = 'none';
        suppressClickAfterBox = true;
        const rect = renderer.domElement.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const minX = Math.min(start.x, x);
        const maxX = Math.max(start.x, x);
        const minY = Math.min(start.y, y);
        const maxY = Math.max(start.y, y);
        const boxed = new Set<number>();
        const box = new THREE.Box3();
        const center = new THREE.Vector3();
        for (const mesh of pickableMeshes()) {
            box.setFromObject(mesh);
            box.getCenter(center);
            // Behind the camera the projection flips; drop those faces.
            const inCamera = center.clone().applyMatrix4(camera.matrixWorldInverse);
            if (inCamera.z >= 0) {
                continue;
            }
            const projected = center.project(camera);
            const sx = ((projected.x + 1) / 2) * rect.width;
            const sy = ((1 - projected.y) / 2) * rect.height;
            if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
                boxed.add(mesh.userData.solidId as number);
            }
        }
        if (boxed.size === 0) {
            return;
        }
        onSelect(addSolidsToSelection(currentSelection, [...boxed]));
    };
    renderer.domElement.addEventListener('pointerdown', onBoxSelectPointerDown);
    window.addEventListener('pointermove', onBoxSelectPointerMove);
    window.addEventListener('pointerup', onBoxSelectPointerUp);
    const onBoxSelectPointerCancel = (): void => {
        boxSelectStart = undefined;
        boxSelectDrawn = false;
        boxSelectBand.style.display = 'none';
    };
    window.addEventListener('pointercancel', onBoxSelectPointerCancel);

    const onClick = (event: MouseEvent) => {
        // A rubber-band drag ends with a click event too; the box already
        // applied the selection, so there is nothing left to pick.
        if (suppressClickAfterBox) {
            suppressClickAfterBox = false;
            return;
        }
        // Canvas clicks never need a bottom-bar popover open; the popover
        // buttons live outside the canvas so this cannot eat their presses.
        onClosePopover();
        if (controller.isActive) {
            return;
        }
        if (measureState.active && measureState.mode === 'model3d') {
            const rect = renderer.domElement.getBoundingClientRect();
            const ndc = pointerToNdc(event.clientX, event.clientY, rect);
            if (measureState.tool === 'radius') {
                // Radius picks edges, which stay visible and pickable under
                // edges-only shading. Non-circular picks warn instead of
                // committing a bogus number.
                const hit = raycastEdge(pickableEdgeLines(), raycaster, ndc, camera);
                if (hit !== undefined) {
                    const result = edgeRadius({
                        curveType: hit.fingerprint?.curveType,
                        fingerprintCenter: hit.fingerprint?.center,
                        points: lineGeometryPoints(hit.line)
                    });
                    if (result.ok) {
                        edgeHighlighter.clear();
                        measureHover = undefined;
                        onMeasureRadius(result.center, result.radius);
                        renderScene();
                    } else {
                        messageService.warn(result.reason);
                    }
                }
                return;
            }
            if (shading === 'edgesOnly') {
                // Faces are hidden under edges-only shading; the hint pill explains why clicks no-op.
                return;
            }
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined && hit.point !== undefined) {
                measureHover = undefined;
                onMeasurePoint([hit.point.x, hit.point.y, hit.point.z]);
                renderScene();
            }
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = pointerToNdc(event.clientX, event.clientY, rect);
        if (activeDressUpPickMode !== undefined) {
            if (activeDressUpPickMode.selecting === 'edge') {
                const hit = raycastEdge(pickableEdgeLines(), raycaster, ndc, camera);
                if (hit !== undefined) {
                    edgeHighlighter.clear();
                    onEdgePick(hit, activeDressUpPickMode.tangentChain === true ? edgeLines : undefined);
                }
            } else {
                // Faces are hidden under edges-only shading; face picking no-ops.
                const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
                if (hit !== undefined) {
                    faceHighlighter.clear();
                    onFacePickDressUp(hit);
                }
            }
            return;
        }
        if (activeHolePickMode) {
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.clear();
                onHolePick(hit);
            }
            return;
        }
        if (activeCurvePickMode) {
            pointer.x = ndc.x;
            pointer.y = ndc.y;
            raycaster.setFromCamera(pointer, camera);
            raycaster.params.Line.threshold = Math.max(lastDiag * 0.01, 1e-3);
            const intersects = raycaster.intersectObjects(pickableCurveLines(), false);
            if (intersects.length > 0) {
                const picked = intersects[0].object.userData.curveId;
                curvePickHoverId = undefined;
                applyCurveHighlight();
                onCurvePick(typeof picked === 'string' ? picked : '');
            }
            return;
        }
        if (activeDrawingDimensionPickMode) {
            // Drawing-dimension pick mirrors dress-up edge picking, but stays
            // active across picks (distance needs two edges): the sheet
            // commits the dimension and cancels the broker request.
            const hit = raycastEdge(pickableEdgeLines(), raycaster, ndc, camera);
            if (hit !== undefined) {
                edgeHighlighter.clear();
                onDrawingDimensionEdgePick(hit);
            }
            return;
        }
        if (activeConnectorPickMode) {
            // Connector pick mirrors dress-up: click a part face to pick its
            // nearest connector (guarded by `resolveConnectorPick` against
            // deleted instances); right-click/Escape cancels.
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined && hit.point !== undefined) {
                const connectorId = nearestConnectorToHit(hit);
                faceHighlighter.clear();
                if (connectorId !== undefined) {
                    onConnectorPick(connectorId);
                }
            }
            return;
        }
        if (activeFacePickMode !== undefined) {
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.clear();
                onFacePick(hit);
            }
            return;
        }
        // Alt+click cycles overlapping faces without any pick, measure, or
        // sketch mode active (all of those returned above). One or zero
        // candidates fall through to the normal click path. Ctrl/Cmd additive
        // picks are untouched whenever Alt is not held.
        if (event.altKey) {
            const candidates = raycastFaceCandidates(pickableMeshes(), raycaster, ndc, camera);
            if (candidates.length > 1) {
                documentStore.selectCurve(undefined);
                const currentIndex = candidates.findIndex(
                    (candidate) => candidate.solidId === currentSelection.solidId && candidate.faceId === currentSelection.faceId
                );
                const next = candidates[(currentIndex + 1) % candidates.length];
                onSelect({ solidId: next.solidId, faceId: next.faceId });
                return;
            }
        }
        pointer.x = ndc.x;
        pointer.y = ndc.y;
        raycaster.setFromCamera(pointer, camera);
        // Clicking a solid (or empty space) clears any curve selection so the
        // viewport does not show two active selections.
        documentStore.selectCurve(undefined);
        // Hidden solids and edges-only shading remove their meshes from the
        // pick pool; a click on them degrades to an empty-space click.
        const intersects = raycaster.intersectObjects(pickableMeshes(), false);
        if (intersects.length > 0) {
            const data = intersects[0].object.userData;
            const solidId = data.solidId as number;
            if (event.ctrlKey || event.metaKey) {
                // Additive pick: toggle the solid inside the multi-selection
                // (same bookkeeping as outline Ctrl+click); empty space never
                // clears an additive click.
                onSelect(toggleSolidSelection(currentSelection, solidId, true));
            } else {
                onSelect({ solidId, faceId: data.faceId as number });
            }
        } else if (!event.ctrlKey && !event.metaKey) {
            onSelect({});
        }
    };
    renderer.domElement.addEventListener('click', onClick);

    // Double-click a solid to select it and frame it. In sketch mode a
    // double-click finishes the in-progress entity (B-spline pole gesture).
    const onDblClick = (event: MouseEvent): void => {
        if (controller.isActive) {
            controller.finishInProgress().catch((err) => {
                console.error('[CAD] finish in-progress failed:', err);
            });
            return;
        }
        if (
            activeFacePickMode !== undefined ||
            activeDressUpPickMode !== undefined ||
            activeHolePickMode ||
            activeCurvePickMode ||
            activeDrawingDimensionPickMode ||
            activeConnectorPickMode
        ) {
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = pointerToNdc(event.clientX, event.clientY, rect);
        pointer.x = ndc.x;
        pointer.y = ndc.y;
        raycaster.setFromCamera(pointer, camera);
        const intersects = raycaster.intersectObjects(pickableMeshes(), false);
        if (intersects.length > 0) {
            const data = intersects[0].object.userData;
            onSelect({ solidId: data.solidId as number, faceId: data.faceId as number });
            fitToSolid(data.solidId as number);
        }
    };
    renderer.domElement.addEventListener('dblclick', onDblClick);

    const onPickPointerMove = (event: PointerEvent): void => {
        if (controller.isActive) {
            return;
        }
        if (measureState.active && measureState.mode === 'model3d') {
            const rect = renderer.domElement.getBoundingClientRect();
            const ndc = pointerToNdc(event.clientX, event.clientY, rect);
            if (measureState.tool === 'radius') {
                const hit = raycastEdge(pickableEdgeLines(), raycaster, ndc, camera);
                if (hit !== undefined) {
                    edgeHighlighter.highlight(hit.line);
                } else {
                    edgeHighlighter.clear();
                }
                renderScene();
                return;
            }
            if (shading === 'edgesOnly') {
                measureHover = undefined;
            } else {
                const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
                measureHover = hit?.point !== undefined ? [hit.point.x, hit.point.y, hit.point.z] : undefined;
            }
            renderScene();
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = pointerToNdc(event.clientX, event.clientY, rect);
        if (activeDressUpPickMode?.selecting === 'edge') {
            const hit = raycastEdge(pickableEdgeLines(), raycaster, ndc, camera);
            if (hit !== undefined) {
                edgeHighlighter.highlight(hit.line);
            } else {
                edgeHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeDressUpPickMode?.selecting === 'face') {
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.highlight(hit.mesh);
            } else {
                faceHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeHolePickMode) {
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.highlight(hit.mesh);
            } else {
                faceHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeCurvePickMode) {
            pointer.x = ndc.x;
            pointer.y = ndc.y;
            raycaster.setFromCamera(pointer, camera);
            raycaster.params.Line.threshold = Math.max(lastDiag * 0.01, 1e-3);
            const intersects = raycaster.intersectObjects(pickableCurveLines(), false);
            const hoverId = intersects.length > 0 ? (intersects[0].object.userData.curveId as string | undefined) : undefined;
            if (hoverId !== curvePickHoverId) {
                curvePickHoverId = hoverId;
                applyCurveHighlight();
            }
            renderScene();
            return;
        }
        if (activeDrawingDimensionPickMode) {
            const hit = raycastEdge(pickableEdgeLines(), raycaster, ndc, camera);
            if (hit !== undefined) {
                edgeHighlighter.highlight(hit.line);
            } else {
                edgeHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeConnectorPickMode) {
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.highlight(hit.mesh);
            } else {
                faceHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeFacePickMode !== undefined) {
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.highlight(hit.mesh);
            } else {
                faceHighlighter.clear();
            }
            renderScene();
        }
    };
    renderer.domElement.addEventListener('pointermove', onPickPointerMove);

    const dispatchSketchMenuAction = (action: SketchContextMenuAction): void => {
        switch (action.kind) {
            case 'constraint':
            case 'valueConstraint':
                controller.applyConstraintToTargets(action.constraint, action.targetIds).catch((err) => {
                    console.error('[CAD] sketch context constraint failed:', err);
                });
                break;
            case 'setConstruction':
                controller.setPrimitivesConstruction(action.ids, action.construction).catch((err) => {
                    console.error('[CAD] sketch context construction failed:', err);
                });
                break;
            case 'delete':
                controller.deletePrimitives(action.ids).catch((err) => {
                    console.error('[CAD] sketch context delete failed:', err);
                });
                break;
            case 'clearSelection':
                controller.clearSelection();
                break;
            case 'fitSketch':
                controller.fitView();
                break;
            case 'toggleGrid':
                controller.setGridEnabled(action.enabled);
                break;
            case 'finishSketch':
                onExitSketch().catch((err) => {
                    console.error('[CAD] finish sketch from context menu failed:', err);
                });
                break;
        }
    };

    const openSketchMenu = (event: MouseEvent): void => {
        const targetId = controller.getContextTargetIdAt(event.clientX, event.clientY);
        controller.selectPrimitiveForContextMenu(targetId);
        controller.dismissConstraintPopover();
        const selection: SketchContextTarget[] = controller.getSelectedPrimitives().map((primitive) => ({
            id: primitive.id,
            type: primitive.type,
            construction: primitive.construction,
            linePointIds: primitive.type === 'line' ? ([primitive.p1Id, primitive.p2Id] as const) : undefined
        }));
        const rect = container.getBoundingClientRect();
        const menu = openContextMenu(
            container,
            buildSketchContextMenu({
                selection,
                gridEnabled: controller.isGridEnabled(),
                canvas: targetId === undefined
            }),
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            dispatchSketchMenuAction,
            { className: 'cad-sketch-context-menu' }
        );
        closeContextMenu = menu;
    };

    const onContextMenu = (event: MouseEvent): void => {
        if (
            activeFacePickMode === undefined &&
            activeDressUpPickMode === undefined &&
            !activeHolePickMode &&
            !activeCurvePickMode &&
            !activeDrawingDimensionPickMode &&
            !activeConnectorPickMode
        ) {
            // No pick mode: the viewport's own menu replaces the browser
            // default. An empty document has nothing to act on.
            if (controller.isActive) {
                event.preventDefault();
                // A right-click during a drawing/constraint gesture cancels it,
                // matching the Escape gesture, instead of stacking a menu over
                // the in-progress preview.
                if (
                    controller.getTool() !== 'select' ||
                    controller.getSession()?.isInProgress() === true ||
                    controller.getConstraintInput() !== undefined
                ) {
                    controller.cancel();
                    if (controller.getTool() !== 'select') {
                        controller.setTool('select');
                    }
                    return;
                }
                controller.cancelAutoDimension();
                openSketchMenu(event);
                return;
            }
            if (meshes.length === 0) {
                return;
            }
            event.preventDefault();
            closeViewportOverlays();
            const rect = renderer.domElement.getBoundingClientRect();
            const ndc = pointerToNdc(event.clientX, event.clientY, rect);
            const pickable = pickableMeshes();
            const hit = raycastFace(pickable, raycaster, ndc, camera);
            // Every distinct face under the pointer feeds Select Other; the
            // nearest one is the normal menu's solid/feature target.
            const candidates = raycastFaceCandidates(pickable, raycaster, ndc, camera);
            contextMenuCandidates = candidates;
            // Attribution: instance → feature via the source body id
            // (`body:<bodyId>` same-document parts); plain faces use bodyId.
            const instanceId = (hit?.mesh.userData as { instanceId?: unknown } | undefined)?.instanceId;
            let bodyId = hit?.bodyId;
            if (bodyId === undefined && typeof instanceId === 'string') {
                const assembly = documentStore.document !== undefined ? getAssemblySection(documentStore.document) : undefined;
                const part = assembly?.instances.find((i) => i.id === instanceId)?.part;
                if (part !== undefined && part.startsWith('body:')) {
                    bodyId = part.slice('body:'.length);
                }
            }
            const featureId = attributeBodyToFeature(bodyId, documentStore.document?.features);
            const containerRect = container.getBoundingClientRect();
            const anchor = { x: event.clientX - containerRect.left, y: event.clientY - containerRect.top };
            const menu = openViewportContextMenu(
                container,
                buildViewportContextMenu({
                    solid: hit !== undefined ? { solidId: hit.solidId, featureId, bodyId } : undefined,
                    explodeFactor,
                    hiddenCount: hiddenSolidIds.size,
                    sectionActive: isSectionActive(),
                    selectedIds: currentSelection.solidIds ?? (currentSelection.solidId !== undefined ? [currentSelection.solidId] : []),
                    hasSelection: hasViewportSelection(),
                    selectOtherCount: candidates.length
                }),
                anchor,
                (action) => {
                    if (action.kind !== 'selectOther') {
                        contextMenuCandidates = [];
                    }
                    switch (action.kind) {
                        case 'editFeature':
                            onEditFeatureRequest(action.featureId);
                            break;
                        case 'measure':
                            onStartMeasureTool(action.tool);
                            break;
                        case 'fitSolid':
                            fitToSolid(action.solidId);
                            break;
                        case 'hideSolid':
                            onHideSolid(action.solidId);
                            break;
                        case 'isolateSolid':
                            onIsolateSolid(action.solidId);
                            break;
                        case 'hideSolids':
                            onHideSolids(action.solidIds);
                            break;
                        case 'isolateSolids':
                            onIsolateSolids(action.solidIds);
                            break;
                        case 'fitAll':
                            fitAllView();
                            break;
                        case 'resetExplode':
                            onResetExplode();
                            break;
                        case 'showAll':
                            onShowAllSolids();
                            break;
                        case 'toggleSection':
                            onToggleSection();
                            break;
                        case 'clearSelection':
                            onClearSelection();
                            break;
                        case 'revealFeature':
                            onRevealFeature(action.featureId);
                            break;
                        case 'selectOther': {
                            const rows = buildSelectOtherRows(contextMenuCandidates, documentStore.document, measurementDecimals.length);
                            contextMenuCandidates = [];
                            closeSelectOtherMenu?.();
                            closeSelectOtherMenu = openSelectOtherMenu(container, rows, anchor, (pick) => {
                                // Mirror the normal click path: a viewport pick
                                // clears any curve selection.
                                documentStore.selectCurve(undefined);
                                onSelect({ solidId: pick.solidId, faceId: pick.faceId });
                            });
                            break;
                        }
                        case 'appearance':
                            onOpenBodyAppearance(action.bodyId);
                            break;
                        case 'noop':
                            break;
                    }
                },
                () => {
                    // Outside/Escape/cleanup dismissals end the candidate
                    // session; an item dispatch clears it after use.
                    contextMenuCandidates = [];
                }
            );
            closeContextMenu = menu;
            return;
        }
        event.preventDefault();
        closeViewportOverlays();
        faceHighlighter.clear();
        edgeHighlighter.clear();
        if (activeDressUpPickMode !== undefined) {
            onDressUpPickCancel();
        } else if (activeHolePickMode) {
            onHolePickCancel();
        } else if (activeCurvePickMode) {
            curvePickHoverId = undefined;
            applyCurveHighlight();
            onCurvePickCancel();
        } else if (activeDrawingDimensionPickMode) {
            edgeHighlighter.clear();
            onDrawingDimensionEdgePickCancel();
        } else if (activeConnectorPickMode) {
            faceHighlighter.clear();
            onConnectorPickCancel();
        } else {
            onFacePickCancel();
        }
    };
    renderer.domElement.addEventListener('contextmenu', onContextMenu);

    const updateLastPointerPosition = (event: PointerEvent | MouseEvent): void => {
        const rect = container.getBoundingClientRect();
        lastPointerPosition = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: PointerEvent): void => {
        updateLastPointerPosition(event);
        if (!controller.isActive) {
            return;
        }
        if (measureState.active && measureState.mode === 'sketch') {
            // Left clicks feed the measure tool; pan gestures still reach the sketch controller.
            if (event.button === 0 && !event.shiftKey) {
                const point = measureSketchPoint(event.clientX, event.clientY);
                if (point !== undefined) {
                    measureHover = undefined;
                    onMeasurePoint(point);
                    renderScene();
                }
                return;
            }
            controller.onPointerDown(event.clientX, event.clientY, event.ctrlKey || event.metaKey, event.shiftKey, event.button);
            return;
        }
        controller.onPointerDown(event.clientX, event.clientY, event.ctrlKey || event.metaKey, event.shiftKey, event.button);
    };
    const onSketchPointerMove = (event: PointerEvent): void => {
        updateLastPointerPosition(event);
        if (!controller.isActive) {
            return;
        }
        if (measureState.active && measureState.mode === 'sketch') {
            measureHover = measureSketchPoint(event.clientX, event.clientY);
            renderScene();
            return;
        }
        controller.onPointerMove(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent): void => {
        // A right pointerup precedes `contextmenu` on Windows; letting it reach
        // the session would commit the point the new right-click contract is
        // about to cancel. Middle is still needed to end a pan.
        if (!controller.isActive || (event.button !== 0 && event.button !== 1)) {
            return;
        }
        void controller.onPointerUp(event.clientX, event.clientY);
    };
    const onWheel = (event: WheelEvent): void => {
        if (!controller.isActive) {
            return;
        }
        event.preventDefault();
        controller.onWheel(event.clientX, event.clientY, event.deltaY);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onSketchPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    // Viewport-scoped keyboard handling: the window keydown handlers below only
    // fire while focus sits inside the viewport container (the canvas and every
    // overlay control live inside it), so Theia's own shortcuts keep working
    // when an editor or another widget holds focus. Clicking a blank spot of
    // the viewport pulls focus onto the container; clicking an interactive
    // control lets the browser focus that control, which stays in the container.
    // The tool-key handlers (onKeyDown, section Escape) listen in the CAPTURE
    // phase: Theia's KeybindingRegistry dispatches matched keybindings from a
    // document-capture listener and stopPropagation()s them, so a bubble-phase
    // listener would never see Escape/Enter while e.g. a notification toast is
    // visible. Capture on window runs before document capture; the handlers
    // keep their focus and text-field guards, and keys they don't claim still
    // propagate to Theia.
    const viewportHasFocus = (): boolean => container.contains(document.activeElement);
    const onContainerPointerDown = (event: PointerEvent): void => {
        const target = event.target;
        if (target instanceof Element && target.closest('button, input, select, textarea, a[href], [tabindex]')) {
            return;
        }
        container.focus({ preventScroll: true });
    };
    container.addEventListener('pointerdown', onContainerPointerDown);

    const onKeyDown = (event: KeyboardEvent): void => {
        if (!viewportHasFocus()) {
            return;
        }
        if (activeDressUpPickMode !== undefined) {
            if (event.key === 'Escape') {
                event.preventDefault();
                faceHighlighter.clear();
                edgeHighlighter.clear();
                onDressUpPickCancel();
            }
            return;
        }
        if (activeHolePickMode) {
            if (event.key === 'Escape') {
                event.preventDefault();
                faceHighlighter.clear();
                onHolePickCancel();
            }
            return;
        }
        if (activeCurvePickMode) {
            if (event.key === 'Escape') {
                event.preventDefault();
                curvePickHoverId = undefined;
                applyCurveHighlight();
                onCurvePickCancel();
            }
            return;
        }
        if (activeDrawingDimensionPickMode) {
            if (event.key === 'Escape') {
                event.preventDefault();
                edgeHighlighter.clear();
                onDrawingDimensionEdgePickCancel();
            }
            return;
        }
        if (activeConnectorPickMode) {
            if (event.key === 'Escape') {
                event.preventDefault();
                faceHighlighter.clear();
                onConnectorPickCancel();
            }
            return;
        }
        if (activeFacePickMode !== undefined) {
            if (event.key === 'Escape') {
                event.preventDefault();
                faceHighlighter.clear();
                onFacePickCancel();
            }
            return;
        }
        // Measure sits below the pick modes in the escape chain but above the
        // sketch session: while measuring, Enter/Escape end the tool instead of
        // cancelling a sketch operation. Text fields keep their keys.
        if (measureState.active) {
            if (event.key === 'Escape' || event.key === 'Enter') {
                const target = event.target;
                const isTextField =
                    target instanceof HTMLInputElement ||
                    target instanceof HTMLTextAreaElement ||
                    target instanceof HTMLSelectElement ||
                    (target instanceof HTMLElement && target.isContentEditable);
                if (!isTextField) {
                    event.preventDefault();
                    onMeasureDeactivate();
                }
            }
            return;
        }
        // Document-mode Escape clears the selection. It sits after the pick and
        // measure branches (they return above) but before the sketch-session
        // block below, so it never takes Escape from an active tool. Section
        // view, transient overlays, and dialogs own Escape through their own
        // handlers and leave selection clearing to a later press.
        if (
            event.key === 'Escape' &&
            !controller.isActive &&
            !measureState.active &&
            !isSectionActive() &&
            activeFacePickMode === undefined &&
            activeDressUpPickMode === undefined &&
            !activeHolePickMode &&
            !activeCurvePickMode &&
            !activeDrawingDimensionPickMode &&
            !activeConnectorPickMode &&
            hasViewportSelection() &&
            // Transient overlays own Escape: the menu, shortcut bar, and command
            // search run their own window-capture handlers, and NukeDialog
            // listens on document capture, which this handler's
            // stopPropagation() would swallow.
            container.querySelector(
                '.cad-viewport-context-menu, .cad-select-other-menu, .cad-shortcut-bar, .cad-command-search-popover, [role="dialog"]'
            ) === null
        ) {
            const target = event.target;
            const isTextField =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement ||
                (target instanceof HTMLElement && target.isContentEditable);
            if (!isTextField) {
                event.preventDefault();
                event.stopPropagation();
                onClearSelection();
            }
        }
        // Q shortcut bar: available in both document and sketch mode when no
        // transient tool or text field is active and no modifier is held.
        if (event.key === 'q' || event.key === 'Q') {
            const target = event.target;
            const isTextField =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement ||
                (target instanceof HTMLElement && target.isContentEditable);
            if (!isTextField && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                event.preventDefault();
                const mode = controller.isActive ? 'sketch' : 'document';
                onShortcutBarRequest(mode, { ...lastPointerPosition });
            }
            return;
        }

        if (!controller.isActive) {
            return;
        }
        // The right-click menu owns its own Escape dismissal; do not also clear
        // the sketch selection or delete geometry behind it.
        if (container.querySelector('.cad-viewport-context-menu') !== null) {
            return;
        }
        // Text fields (constraint value box, dimension editor, parameters panel)
        // consume Delete/Backspace/Escape; never route them to the sketch session.
        const target = event.target;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        ) {
            return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            controller.onDeleteKey();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            controller.onEscape();
        } else if (event.key === 'Enter') {
            // Enter finishes the in-progress entity (B-spline pole gesture).
            event.preventDefault();
            controller.finishInProgress().catch((err) => {
                console.error('[CAD] finish in-progress failed:', err);
            });
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            if (event.key === 'm' || event.key === 'M') {
                // Mode key for polyline/rectangle/polygon variants (not a tool shortcut).
                event.preventDefault();
                controller.cycleToolMode();
                return;
            }
            const tool = SKETCH_TOOL_SHORTCUTS[event.key.toLowerCase()];
            if (tool !== undefined) {
                event.preventDefault();
                controller.setTool(tool);
            }
        }
    };
    window.addEventListener('keydown', onKeyDown, true);

    // Freeze navigation while an additive-select modifier is held (see
    // applyControlsEnabled). Keyup outside the window loses the release, so
    // blur also resets; typing in inputs is unaffected (orbit only acts on
    // canvas gestures, and pick handlers already read the same modifiers).
    const onAdditiveModifierDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Control' && event.key !== 'Meta') {
            return;
        }
        if (!additiveModifierHeld) {
            additiveModifierHeld = true;
            applyControlsEnabled();
            // Crosshair signals pick mode; cleared on release/blur/cleanup.
            renderer.domElement.style.cursor = 'crosshair';
        }
    };
    const onAdditiveModifierUp = (event: KeyboardEvent): void => {
        if (event.key !== 'Control' && event.key !== 'Meta') {
            return;
        }
        if (!event.ctrlKey && !event.metaKey) {
            additiveModifierHeld = false;
            applyControlsEnabled();
            renderer.domElement.style.cursor = '';
        }
    };
    const onAdditiveModifierBlur = (): void => {
        if (additiveModifierHeld) {
            additiveModifierHeld = false;
            applyControlsEnabled();
            renderer.domElement.style.cursor = '';
        }
    };
    window.addEventListener('keydown', onAdditiveModifierDown);
    window.addEventListener('keyup', onAdditiveModifierUp);
    window.addEventListener('blur', onAdditiveModifierBlur);

    const onFitKey = (event: KeyboardEvent): void => {
        if (!viewportHasFocus()) {
            return;
        }
        if (event.key !== 'f' && event.key !== 'F' && event.key !== '.') {
            return;
        }
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
            return;
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
            return;
        }
        if (target instanceof HTMLElement && target.closest('.cad-viewport-context-menu') !== null) {
            return;
        }
        if (controller.isActive) {
            // The sketch context menu advertises F for Fit Sketch; the
            // document-only guard must not swallow it in sketch mode.
            event.preventDefault();
            controller.fitView();
            return;
        }
        if (
            activeFacePickMode !== undefined ||
            activeDressUpPickMode !== undefined ||
            activeHolePickMode ||
            activeCurvePickMode ||
            activeDrawingDimensionPickMode
        ) {
            return;
        }
        fitView();
    };
    window.addEventListener('keydown', onFitKey);

    // Tab toggles sketch mode (enter when idle, exit while sketching).
    const onTabKey = (event: KeyboardEvent): void => {
        if (!viewportHasFocus()) {
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        if (
            activeFacePickMode !== undefined ||
            activeDressUpPickMode !== undefined ||
            activeHolePickMode ||
            activeCurvePickMode ||
            activeDrawingDimensionPickMode
        ) {
            return;
        }
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
            return;
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
            return;
        }
        event.preventDefault();
        // A context menu is an unmanaged DOM child of the persistent container;
        // dismiss it before React swaps the document/sketch branches.
        closeViewportOverlays();
        onToggleSketchMode();
    };
    window.addEventListener('keydown', onTabKey);

    // Escape exits section mode unless a pick mode, sketch session, dialog,
    // command search, or text field consumes the key first (same guards as the
    // fit/tab keys), and always closes an open bottom-bar popover.
    // Capture phase, for the same Theia keybinding race as onKeyDown.
    const onSectionEscapeKey = (event: KeyboardEvent): void => {
        if (!viewportHasFocus()) {
            return;
        }
        if (event.key !== 'Escape') {
            return;
        }
        if (container.querySelector('.cad-command-search-popover') !== null) {
            // The popover's own capture handler closes it and stops the event;
            // never exit section mode on the same press.
            return;
        }
        if (
            controller.isActive ||
            activeFacePickMode !== undefined ||
            activeDressUpPickMode !== undefined ||
            activeHolePickMode ||
            activeCurvePickMode ||
            activeDrawingDimensionPickMode
        ) {
            return;
        }
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
            return;
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
            return;
        }
        event.preventDefault();
        onClosePopover();
        if (activeSection === undefined) {
            return;
        }
        activeSection = undefined;
        applyShading();
        onExitSection();
    };
    window.addEventListener('keydown', onSectionEscapeKey, true);

    // Fires immediately with the current selection, then on every change.
    const selectionDisposable = subscribeSelection((selection) => {
        currentSelection = selection;
        applyHighlight();
    });

    // Per-body appearance overrides are document state but display-only: every
    // store change re-derives the material map and re-applies shading (which
    // re-renders). Rebuild scheduling belongs to the widget, never this sync.
    const unsubscribeBodyAppearances = documentStore.onChange(() => {
        syncBodyAppearances();
        applyShading();
    });
    // Fires immediately with the current hidden set, then on every change;
    // applyShading re-applies visibility and re-renders.
    const hiddenSolidsDisposable = subscribeHiddenSolids((ids) => {
        hiddenSolidIds = new Set(ids);
        applyShading();
    });

    // Re-reads the theme CSS vars and re-colors scene + shared materials. A
    // no-op re-read when the vars are unchanged. Theme and gradient styles
    // re-resolve here; dark/light stay fixed to their constants.
    const applyThemeColors = (): void => {
        const nextBackground = applyBackground();
        const nextColors = cadViewportColors(nextBackground, readThemeColor(container, '--theia-foreground', '#cccccc'));
        baseColor.set(nextColors.body);
        edgeColor.set(nextColors.edges);
        // Shared materials re-color in place; per-mesh state is untouched.
        bodyMaterial.color.copy(baseColor);
        syncBodyAppearances();
        recolorBodyAppearanceMaterials();
        edgeLineMaterial.color.set(edgeColor);
        curveLineMaterial.color.set(edgeColor);
        previewGhostMaterial.color.copy(baseColor);
        selectedColor.set(readThemeColor(container, '--theia-focusBorder', '#007fd4'));
        applyHighlight();
        controller.refreshThemeColors();
        renderScene();
    };

    let themeColorsDisposed = false;
    const themeDisposable = subscribeThemeChange(applyThemeColors);
    // The initial scene background was read synchronously above; at startup
    // the theme stylesheet can still be injecting, so the first read may fall
    // back to the dark default under a light theme. Re-read once after first
    // paint — a no-op when the vars already resolved.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!themeColorsDisposed) {
                applyThemeColors();
            }
        });
    });

    const resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
            controller.onResize();
            renderScene();
        }
    });
    resizeObserver.observe(container);

    renderScene();

    return {
        controller,
        updateModel: buildModel,
        updateSelectedCurve: (curveId) => {
            selectedCurveId = curveId;
            applyCurveHighlight();
            renderScene();
        },
        setFacePickMode: (mode) => {
            activeFacePickMode = mode;
            if (mode === undefined) {
                faceHighlighter.clear();
            }
            renderScene();
        },
        setDressUpPickMode: (mode) => {
            activeDressUpPickMode = mode;
            if (mode === undefined) {
                faceHighlighter.clear();
                edgeHighlighter.clear();
            }
            renderScene();
        },
        setHolePickMode: (active) => {
            activeHolePickMode = active;
            if (!active) {
                faceHighlighter.clear();
            }
            renderScene();
        },
        setCurvePickMode: (active) => {
            activeCurvePickMode = active;
            if (!active) {
                curvePickHoverId = undefined;
                applyCurveHighlight();
            }
            renderScene();
        },
        setDrawingDimensionPickMode: (active) => {
            activeDrawingDimensionPickMode = active;
            if (!active) {
                edgeHighlighter.clear();
            }
            renderScene();
        },
        setConnectorPickMode: (active) => {
            activeConnectorPickMode = active;
            if (!active) {
                faceHighlighter.clear();
            }
            renderScene();
        },
        setConnectorTriads,
        setPreviewTessellation,
        setOriginAxes,
        fitView,
        zoomView,
        setStandardView,
        getCameraState,
        setCameraState,
        setShading,
        setGhostOpacity,
        setColorByMaterial,
        setViewportBackground,
        setNavigationStyle,
        setSection,
        setExplodeFactor: (factor) => {
            explodeFactor = clampExplodeFactor(factor);
            applyExplode();
            renderScene();
        },
        snapView: (direction) => {
            setViewDirection(direction);
        },
        setAutoDimensionEnabled: (enabled) => {
            controller.setAutoDimensionEnabled(enabled);
        },
        updateMeasureState: (state) => {
            measureState = state;
            if (!state.active) {
                measureHover = undefined;
                edgeHighlighter.clear();
            }
            syncMeasureObjects();
            renderScene();
        },
        setMeasurementDecimals: (decimals) => {
            measurementDecimals.length = decimals.length;
            measurementDecimals.angle = decimals.angle;
            // Committed labels cache their text; refresh them on the next paint.
            renderScene();
        },
        cleanup: () => {
            closeViewportOverlays();
            container.classList.remove('cad-viewport-gradient');
            measureLabelLayer.remove();
            scene.remove(measureGroup);
            for (const visual of measureVisuals.values()) {
                if (visual.type === 'segment') {
                    visual.line.geometry.dispose();
                } else if (visual.type === 'angle') {
                    visual.lineBA.geometry.dispose();
                    visual.lineBC.geometry.dispose();
                }
            }
            measureVisuals.clear();
            pendingLine.geometry.dispose();
            measureSphereGeometry.dispose();
            measureLineMaterial.dispose();
            measureSphereMaterial.dispose();
            selectionDisposable.dispose();
            hiddenSolidsDisposable.dispose();
            unsubscribeBodyAppearances();
            disposeBodyAppearanceMaterials();
            themeColorsDisposed = true;
            themeDisposable.dispose();
            resizeObserver.disconnect();
            renderer.domElement.removeEventListener('click', onClick);
            renderer.domElement.removeEventListener('dblclick', onDblClick);
            renderer.domElement.removeEventListener('pointermove', onPickPointerMove);
            renderer.domElement.removeEventListener('contextmenu', onContextMenu);
            renderer.domElement.removeEventListener('pointerdown', onPointerDown);
            renderer.domElement.removeEventListener('pointerdown', onBoxSelectPointerDown);
            window.removeEventListener('pointermove', onBoxSelectPointerMove);
            window.removeEventListener('pointerup', onBoxSelectPointerUp);
            window.removeEventListener('pointercancel', onBoxSelectPointerCancel);
            boxSelectBand.remove();
            renderer.domElement.style.cursor = '';
            renderer.domElement.removeEventListener('pointermove', onSketchPointerMove);
            renderer.domElement.removeEventListener('pointerup', onPointerUp);
            renderer.domElement.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keydown', onAdditiveModifierDown);
            window.removeEventListener('keyup', onAdditiveModifierUp);
            window.removeEventListener('blur', onAdditiveModifierBlur);
            window.removeEventListener('keydown', onFitKey);
            window.removeEventListener('keydown', onTabKey);
            window.removeEventListener('keydown', onSectionEscapeKey, true);
            container.removeEventListener('pointerdown', onContainerPointerDown);
            controls.removeEventListener('start', onViewInteractionStart);
            controls.removeEventListener('change', renderScene);
            controls.dispose();
            controller.dispose();
            renderer.dispose();
            faceHighlighter.dispose();
            edgeHighlighter.dispose();
            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }
            // Instance groups share one BufferGeometry per source face —
            // dispose each geometry once.
            for (const geometry of new Set(meshes.map((mesh) => mesh.geometry))) {
                geometry.dispose();
            }
            for (const lines of connectorTriadLines) {
                lines.geometry.dispose();
                (lines.material as THREE.Material).dispose();
            }
            for (const line of edgeLines) {
                line.geometry.dispose();
            }
            for (const line of curveLines) {
                line.geometry.dispose();
            }
            for (const mesh of previewMeshes) {
                mesh.geometry.dispose();
            }
            bodyMaterial.dispose();
            highlightMaterial.dispose();
            edgeLineMaterial.dispose();
            curveLineMaterial.dispose();
            curveLineHighlightMaterial.dispose();
            previewGhostMaterial.dispose();
            previewMeshes = [];
            scene.remove(previewGroup);
            for (const line of originAxisLines) {
                line.geometry.dispose();
                (line.material as THREE.Material).dispose();
            }
            scene.remove(originAxesGroup);
        }
    };
}

function buildCurveLine(curve: ParsedTessCurve, material: THREE.LineBasicMaterial): THREE.Line {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(curve.positions, 3));
    const line = new THREE.Line(geometry, material);
    line.userData = { curveId: curve.id, name: curve.name, closed: curve.closed };
    return line;
}

function readThemeColor(element: HTMLElement, variable: string, fallback: string): string {
    const value = getComputedStyle(element).getPropertyValue(variable).trim();
    return value || fallback;
}
