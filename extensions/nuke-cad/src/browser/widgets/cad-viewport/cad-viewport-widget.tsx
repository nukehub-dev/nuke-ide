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
import { NukeCadCommands } from '../../commands';
import { LoadingAnimations } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { NukeEmptyState, NukeLoadingOverlay } from 'nuke-essentials/lib/theme/browser/components';
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
import { CadDocumentStore, createSketchId, createFeatureId, computeDependsOn } from '../../document/cad-document-store';
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
import { DOCUMENT_TEMPLATES } from '../../../common/document-templates';
import {
    type SketchDef,
    type FeatureDef,
    type FeatureType,
    type FeatureParams,
    type CurvePoint,
    type NukeCadDocument
} from '../../../common/cad-document';
import { type TopologyRef } from '../../../common/topology-refs';
import { FaceHighlighter, type FacePickHit, buildTopologyRef, pointerToNdc, projectHitToFaceUv, raycastFace } from './face-picker';
import { cadViewportColors, resolveViewportBackground, type ViewportBackgroundStyle } from './viewport-colors';
import { applyNavigationStyle, type NavigationStyle } from './navigation-styles';
import { EdgeHighlighter, type EdgePickHit, buildEdgeLine, buildEdgeTopologyRef, raycastEdge } from './edge-picker';
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
    type Measurement,
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
import { headerRegionTarget, useDraggablePanel } from './draggable-panel';
import { buildFeaturePreviewDocument, resolveCurvePick, type FeaturePreviewRequest } from './sweep-pipe';
import { faceReuseKey, planFaceReuse, type ParsedTessCurve, type ParsedTessData } from './tess-reuse';
import { parseTessellationAsync } from './tess-parse-client';
import { attributeBodyToFeature, buildViewportContextMenu, openViewportContextMenu } from './viewport-context-menu';
import './cad-viewport.css';
import './cad-icons.css';

/** Tessellation payload in its transfer-friendly parsed form (typed arrays). */
type TessData = ParsedTessData;

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

    /** True while the datum picker is waiting for the user to choose a plane. */
    sketchSetupVisible = false;
    /** True while the sketch solver is loading (Start Sketch clicked, session not active yet). */
    sketchEntering = false;
    /** True while a feature creation dialog is open. */
    featureCreationType?: FeatureType;
    /** Id of the feature being edited, when the dialog is in edit mode. */
    editingFeatureId?: string;
    private sketchController?: SketchModeController;
    private sketchCamera?: THREE.PerspectiveCamera;
    /** Id of the sketch being edited, or undefined for a new sketch. */
    private editingSketchId?: string;
    /** Active face-pick mode, if any. */
    private facePickMode?: 'sketchDatum' | 'externalGeometry';
    /** Offset to apply when creating a face datum. */
    private facePickOffset = 0;
    /** Feature id used for external-geometry references (the producing feature). */
    private facePickFeatureId?: string;
    /** Active dress-up pick mode and the callback that receives the next pick. */
    private dressUpPickMode?: { type: FeatureType; selecting: 'edge' | 'face' };
    private dressUpPickCallback?: (ref: TopologyRef) => void;
    /** Active hole face-pick mode and the callback that receives the picked face. */
    private holePickMode?: { callback: (ref: TopologyRef, uv: [number, number]) => void };
    /** Active curve-pick mode and the callback that receives the picked curve id. */
    private curvePickMode?: { callback: (curveId: string) => void };
    /** Tessellation of the pending sweep/pipe draft (ghosted preview), if any. */
    private previewTessData?: TessData;
    /** Monotonically increasing token; stale preview builds are dropped. */
    private featurePreviewToken = 0;
    /** True while the viewport section plane is engaged. */
    private sectionActive = false;

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

        // Boolean, dress-up, pattern/mirror/hole, pipe, and loft features do not consume a sketch.
        const isBoolean = type === 'booleanFuse' || type === 'booleanCut' || type === 'booleanCommon';
        const isDressUp = type === 'fillet' || type === 'chamfer' || type === 'draft' || type === 'shell';
        const isPatternOrMirrorOrHole = type === 'linearPattern' || type === 'circularPattern' || type === 'mirror' || type === 'hole';
        const sketchFree = isBoolean || isDressUp || isPatternOrMirrorOrHole || type === 'pipe' || type === 'loft';
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
        } else if (bodyId === undefined && (type === 'pocket' || type === 'groove')) {
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
            id: createFeatureId(),
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
        callback: (ref: TopologyRef) => void
    ): void => {
        this.dressUpPickMode = { type, selecting };
        this.dressUpPickCallback = callback;
        this.update();
    };

    protected readonly handleDressUpPickCancel = (): void => {
        this.dressUpPickMode = undefined;
        this.dressUpPickCallback = undefined;
        this.update();
    };

    protected readonly handleEdgePick = (hit: EdgePickHit): void => {
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
            const result = await this.backendService.buildDocument({ scriptPath: uri.path.toString() });
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
        this.editingFeatureId = undefined;
        this.dressUpPickMode = undefined;
        this.dressUpPickCallback = undefined;
        this.holePickMode = undefined;
        this.curvePickMode = undefined;
        this.featurePreviewToken++;
        this.previewTessData = undefined;
        this.update();
    };

    protected readonly handleRebuildDocument = (): Promise<void> => this.rebuildDocument();

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
        this.update();
    }

    /** Show the datum-plane picker and prepare to enter sketch mode. */
    startSketchSetup(): void {
        if (!this.documentStore.hasDocument) {
            this.documentStore.createDocument('Untitled');
        }
        this.editingSketchId = undefined;
        this.sketchSetupVisible = true;
        this.update();
    }

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
            this.documentStore.selection.selectedSketchId === undefined
        ) {
            this.messageService.warn('Select a closed sketch in the feature tree before adding a solid feature.');
            return;
        }
        this.editingFeatureId = undefined;
        this.featureCreationType = type;
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
     */
    private async buildPartialWithFallback(filePath: string, featureIds: string[]): Promise<GeometryBuildResult> {
        const jobId = `cad-partial-${Date.now()}-${this.partialJobCounter++}`;
        this.pendingPartialJobId = jobId;
        try {
            const partial = this.backendService.buildFeaturesPartial;
            if (partial === undefined) {
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
            console.warn('[CadViewport] Partial rebuild unavailable, falling back to full build:', error);
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
     * Prompt for a CAD model script or STEP file and load it into the viewport.
     */
    protected async openModel(): Promise<void> {
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
                sketchEntering={this.sketchEntering}
                featureCreationType={this.featureCreationType}
                editingFeatureId={this.editingFeatureId}
                facePickMode={this.facePickMode}
                dressUpPickMode={this.dressUpPickMode}
                selectedCurveId={this.documentStore.selection.selectedCurveId}
                documentStore={this.documentStore}
                templatePickerOpen={this.templatePickerOpen}
                sketchAutoDimension={this.preferences['nukeCad.sketchAutoDimension']}
                viewportBackground={this.preferences['nukeCad.viewportBackground'] as ViewportBackgroundStyle}
                navigationStyle={this.preferences['nukeCad.navigationStyle'] as NavigationStyle}
                rebuildOnEdit={this.preferences['nukeCad.rebuildOnEdit']}
                buildStale={this.buildStale}
                templates={DOCUMENT_TEMPLATES}
                onDismissError={this.dismissBuildError}
                onDismissWarnings={this.dismissBuildWarnings}
                onSelect={this.handleViewportSelect}
                subscribeSelection={this.subscribeSelection}
                subscribeHiddenSolids={this.subscribeHiddenSolids}
                subscribeThemeChange={this.subscribeThemeChange}
                onOpenModel={() => this.openModel()}
                onNewDocument={this.handleNewDocument}
                onCreateDocument={this.handleCreateDocument}
                onCancelTemplatePicker={this.handleCancelTemplatePicker}
                onSaveDocument={this.handleSaveDocument}
                onRebuildDocument={this.handleRebuildDocument}
                onControllerReady={this.handleControllerReady}
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
                previewTessData={this.previewTessData}
                onPreviewChange={this.handleFeaturePreviewChange}
                sectionActive={this.sectionActive}
                onSetSectionActive={this.handleSetSectionActive}
                onExitSection={this.handleExitSection}
                onEditFeatureRequest={this.handleEditFeatureRequest}
                onHideSolid={this.handleHideSolid}
                onIsolateSolid={this.handleIsolateSolid}
                onShowAllSolids={this.handleShowAllSolids}
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
    readonly sketchEntering: boolean;
    readonly featureCreationType?: FeatureType;
    readonly editingFeatureId?: string;
    readonly facePickMode?: 'sketchDatum' | 'externalGeometry';
    readonly dressUpPickMode?: { readonly type: FeatureType; readonly selecting: 'edge' | 'face' };
    readonly holePickMode?: boolean;
    readonly selectedCurveId?: string;
    readonly sectionActive: boolean;
    readonly documentStore: CadDocumentStore;
    readonly messageService: MessageService;
    readonly templatePickerOpen: boolean;
    readonly sketchAutoDimension: boolean;
    readonly viewportBackground: ViewportBackgroundStyle;
    readonly navigationStyle: NavigationStyle;
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
    readonly onStartDressUpPick: (type: FeatureType, selecting: 'edge' | 'face', callback: (ref: TopologyRef) => void) => void;
    readonly onDressUpPickCancel: () => void;
    readonly onEdgePick: (hit: EdgePickHit) => void;
    readonly onFacePickDressUp: (hit: FacePickHit) => void;
    readonly onStartHolePick: (callback: (ref: TopologyRef, uv: [number, number]) => void) => void;
    readonly onHolePick: (hit: FacePickHit) => void;
    readonly onHolePickCancel: () => void;
    readonly onStartCurvePick: (callback: (curveId: string) => void) => void;
    readonly onCurvePick: (curveId: string) => void;
    readonly onCurvePickCancel: () => void;
    readonly curvePickMode?: boolean;
    readonly previewTessData?: TessData;
    readonly onPreviewChange: (request: FeaturePreviewRequest | undefined) => void;
    readonly onSetSectionActive: (active: boolean) => void;
    readonly onExitSection: () => void;
    /** Viewport context menu: open the feature dialog for an attributed feature. */
    readonly onEditFeatureRequest: (featureId: string) => void;
    /** Viewport context menu: hide/isolate/reveal solids via the state manager. */
    readonly onHideSolid: (solidId: number) => void;
    readonly onIsolateSolid: (solidId: number) => void;
    readonly onShowAllSolids: () => void;
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
        setDressUpPickMode?: (mode?: { type: FeatureType; selecting: 'edge' | 'face' }) => void;
        setHolePickMode?: (active: boolean) => void;
        setCurvePickMode?: (active: boolean) => void;
        setPreviewTessellation?: (tessData?: TessData) => void;
        fitView?: () => void;
        zoomView?: (factor: number) => void;
        setStandardView?: (view: 'iso' | 'top' | 'front' | 'right') => void;
        setShading?: (mode: ShadingMode) => void;
        setGhostOpacity?: (value: number) => void;
        setViewportBackground?: (style: ViewportBackgroundStyle) => void;
        setNavigationStyle?: (style: NavigationStyle) => void;
        setSection?: (section?: SectionState) => void;
        setExplodeFactor?: (factor: number) => void;
        setGizmoVisible?: (visible: boolean) => void;
        updateMeasureState?: (state: MeasureViewState) => void;
        setAutoDimensionEnabled?: (enabled: boolean) => void;
    }>({});

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

    const handleMeasureDelete = React.useCallback((id: string): void => {
        setMeasurements((prev) => prev.filter((segment) => segment.id !== id));
    }, []);

    const handleMeasureClear = React.useCallback((): void => {
        setMeasurements([]);
    }, []);

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
        // A rebuild replaces the tessellation; measurements reference the old
        // surface and are session state only, so they never survive it. The
        // explode factor moves with the same rebuild, so it resets too.
        clearMeasurePendings();
        setMeasurements([]);
        setExplodeFactor(0);
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
                props.messageService,
                props.onToggleSketchMode,
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
                () => sectionActiveRef.current,
                handleClosePopover,
                handleToggleSection,
                props.onHideSolid,
                props.onIsolateSolid,
                props.onShowAllSolids
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
            viewportApi.current.setPreviewTessellation = api.setPreviewTessellation;
            viewportApi.current.fitView = api.fitView;
            viewportApi.current.zoomView = api.zoomView;
            viewportApi.current.setStandardView = api.setStandardView;
            viewportApi.current.setShading = api.setShading;
            viewportApi.current.setGhostOpacity = api.setGhostOpacity;
            viewportApi.current.setViewportBackground = api.setViewportBackground;
            viewportApi.current.setNavigationStyle = api.setNavigationStyle;
            viewportApi.current.setSection = api.setSection;
            viewportApi.current.setExplodeFactor = api.setExplodeFactor;
            viewportApi.current.setGizmoVisible = api.setGizmoVisible;
            viewportApi.current.updateMeasureState = api.updateMeasureState;
            viewportApi.current.setAutoDimensionEnabled = api.setAutoDimensionEnabled;
            api.setFacePickMode(props.facePickMode);
            api.setDressUpPickMode(props.dressUpPickMode);
            api.setHolePickMode(props.holePickMode ?? false);
            api.setCurvePickMode(props.curvePickMode ?? false);
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
            viewportApi.current.setPreviewTessellation = undefined;
            viewportApi.current.fitView = undefined;
            viewportApi.current.zoomView = undefined;
            viewportApi.current.setStandardView = undefined;
            viewportApi.current.setShading = undefined;
            viewportApi.current.setGhostOpacity = undefined;
            viewportApi.current.setViewportBackground = undefined;
            viewportApi.current.setNavigationStyle = undefined;
            viewportApi.current.setSection = undefined;
            viewportApi.current.setExplodeFactor = undefined;
            viewportApi.current.setGizmoVisible = undefined;
            viewportApi.current.updateMeasureState = undefined;
            viewportApi.current.setAutoDimensionEnabled = undefined;
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

    React.useEffect(() => {
        viewportApi.current.setNavigationStyle?.(props.navigationStyle);
    }, [props.navigationStyle, controller]);

    React.useEffect(() => {
        if (props.warnings.length > 0) {
            setWarningsOpen(false);
        }
    }, [props.warnings.length]);

    // All hooks must run on every render: the loading branch below returns
    // early, so nothing that calls a hook may sit after it.
    const sketchActive = (controller?.isActive ?? false) || props.sketchSetupVisible || props.sketchEntering;
    const hasTessellation = props.tessData !== undefined;

    // Gizmo and view label are imperative overlays; they are meaningless
    // without geometry, so stay hidden in the empty/loading/document-only
    // states and in sketch mode, and show once a build's tessellation lands.
    React.useEffect(() => {
        viewportApi.current.setGizmoVisible?.(hasTessellation && !sketchActive);
    }, [hasTessellation, sketchActive, controller]);

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
            <div className="cad-viewport-warning-strip">
                <div className="cad-viewport-warning-header">
                    <span className="codicon codicon-warning" />
                    <button className="theia-button secondary cad-viewport-warning-toggle" onClick={() => setWarningsOpen(!warningsOpen)}>
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
                    <div className="cad-viewport-warning-list">
                        {props.warnings.map((warning, index) => (
                            <div key={index} className="cad-viewport-warning-item">
                                {warning}
                            </div>
                        ))}
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
            editFeature={editFeature}
            facePickMode={props.facePickMode}
            dressUpPickMode={props.dressUpPickMode}
            holePickMode={props.holePickMode}
            shortcutBar={shortcutBar}
            sketchAutoDimension={props.sketchAutoDimension}
            templates={props.templates}
            onEnterSketch={props.onEnterSketch}
            onEnterSketchDraft={props.onEnterSketchDraft}
            onExitSketch={props.onExitSketch}
            onStartFeatureCreation={props.onStartFeatureCreation}
            onAddFeature={props.onAddFeature}
            onEditFeature={props.onEditFeature}
            onEditSketch={props.onEditSketch}
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
                <div className="cad-viewport-nav" ref={navRef}>
                    <Tooltip content="Iso view" position="left">
                        <button
                            className="theia-button secondary cad-viewport-nav-button cad-viewport-nav-text"
                            onClick={() => viewportApi.current.setStandardView?.('iso')}
                        >
                            ISO
                        </button>
                    </Tooltip>
                    <Tooltip content="Top view" position="left">
                        <button
                            className="theia-button secondary cad-viewport-nav-button cad-viewport-nav-text"
                            onClick={() => viewportApi.current.setStandardView?.('top')}
                        >
                            T
                        </button>
                    </Tooltip>
                    <Tooltip content="Front view" position="left">
                        <button
                            className="theia-button secondary cad-viewport-nav-button cad-viewport-nav-text"
                            onClick={() => viewportApi.current.setStandardView?.('front')}
                        >
                            F
                        </button>
                    </Tooltip>
                    <Tooltip content="Right view" position="left">
                        <button
                            className="theia-button secondary cad-viewport-nav-button cad-viewport-nav-text"
                            onClick={() => viewportApi.current.setStandardView?.('right')}
                        >
                            R
                        </button>
                    </Tooltip>
                    <span className="cad-viewport-nav-divider" />
                    <Tooltip content="Fit view (F) / selection (.)" position="left">
                        <button className="theia-button secondary cad-viewport-nav-button" onClick={() => viewportApi.current.fitView?.()}>
                            <span className="codicon codicon-screen-full" />
                        </button>
                    </Tooltip>
                    <Tooltip content="Zoom in" position="left">
                        <button
                            className="theia-button secondary cad-viewport-nav-button"
                            onClick={() => viewportApi.current.zoomView?.(0.8)}
                        >
                            <span className="codicon codicon-zoom-in" />
                        </button>
                    </Tooltip>
                    <Tooltip content="Zoom out" position="left">
                        <button
                            className="theia-button secondary cad-viewport-nav-button"
                            onClick={() => viewportApi.current.zoomView?.(1.25)}
                        >
                            <span className="codicon codicon-zoom-out" />
                        </button>
                    </Tooltip>
                    <span className="cad-viewport-nav-divider" />
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
                </div>
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
                        className="cad-viewport-shading-hint"
                        style={navWidth > 0 ? { maxWidth: `calc(100% - ${navWidth + 40}px)` } : undefined}
                    >
                        <span className="codicon codicon-info" />
                        <span className="cad-viewport-shading-hint-text">{statusHints.join(' · ')}</span>
                    </div>
                )}
            </>
        ) : undefined;

    const measureListPopover = measureListOpen ? (
        <MeasureListPopover
            className={measureMode === 'sketch' ? 'cad-sketch-measure-popover' : 'cad-viewport-measure-popover'}
            measurements={modeMeasurements}
            tool={activeMeasureTool}
            showToolSelector={measureMode === 'model3d'}
            onToolChange={handleMeasureToolChange}
            onDelete={handleMeasureDelete}
            onClear={handleMeasureClear}
            onClose={() => setMeasureListOpen(false)}
        />
    ) : undefined;

    if (sketchActive) {
        return (
            <div ref={containerRef} tabIndex={-1} className="cad-viewport empty">
                {banners}
                {dirtyMarker}
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
                <div className="cad-viewport-document-hint">
                    <span className="codicon codicon-info" />
                    Document mode: use the Feature Tree to add sketches and features, then rebuild.
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
            {measureListPopover}
            {sketchOverlay}
            {templatePicker}
        </div>
    );
}

interface MeasureListPopoverProps {
    readonly className: string;
    readonly measurements: readonly Measurement[];
    /** Active capture tool (distance/angle/radius); sketch mode is distance. */
    readonly tool: MeasureToolMode;
    /** Show the mode selector row (model3d popover only). */
    readonly showToolSelector: boolean;
    readonly onToolChange: (tool: MeasureToolMode) => void;
    readonly onDelete: (id: string) => void;
    readonly onClear: () => void;
    readonly onClose: () => void;
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
                            <span className="cad-measure-value">{formatMeasurementValue(measurement)}</span>
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

interface ViewportApi {
    readonly controller: SketchModeController;
    readonly cleanup: () => void;
    readonly updateModel: (tessData?: TessData) => void;
    readonly updateSelectedCurve: (curveId: string | undefined) => void;
    readonly setFacePickMode: (mode?: 'sketchDatum' | 'externalGeometry') => void;
    readonly setDressUpPickMode: (mode?: { type: FeatureType; selecting: 'edge' | 'face' }) => void;
    readonly setHolePickMode: (active: boolean) => void;
    readonly setCurvePickMode: (active: boolean) => void;
    readonly setPreviewTessellation: (tessData?: TessData) => void;
    readonly fitView: () => void;
    readonly zoomView: (factor: number) => void;
    readonly setStandardView: (view: 'iso' | 'top' | 'front' | 'right') => void;
    readonly setShading: (mode: ShadingMode) => void;
    readonly setGhostOpacity: (value: number) => void;
    readonly setViewportBackground: (style: ViewportBackgroundStyle) => void;
    readonly setNavigationStyle: (style: NavigationStyle) => void;
    readonly setSection: (section?: SectionState) => void;
    readonly setExplodeFactor: (factor: number) => void;
    readonly setGizmoVisible: (visible: boolean) => void;
    readonly updateMeasureState: (state: MeasureViewState) => void;
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
    onEdgePick: (hit: EdgePickHit) => void,
    onFacePickDressUp: (hit: FacePickHit) => void,
    onDressUpPickCancel: () => void,
    onStartHolePick: (callback: (ref: TopologyRef, uv: [number, number]) => void) => void,
    onHolePick: (hit: FacePickHit) => void,
    onHolePickCancel: () => void,
    initialHolePickMode: boolean,
    onCurvePick: (curveId: string) => void,
    onCurvePickCancel: () => void,
    initialCurvePickMode: boolean,
    messageService: MessageService,
    onToggleSketchMode: () => void,
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
    isSectionActive: () => boolean,
    onClosePopover: () => void,
    onToggleSection: () => void,
    onHideSolid: (solidId: number) => void,
    onIsolateSolid: (solidId: number) => void,
    onShowAllSolids: () => void
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

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
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

    const modelGroup = new THREE.Group();
    modelGroup.name = 'cad-model';
    scene.add(modelGroup);

    // Ghosted feature-preview solids live in their own group so model rebuilds
    // never dispose them; the dialog's preview toggle owns their lifetime.
    const previewGroup = new THREE.Group();
    previewGroup.name = 'cad-preview';
    scene.add(previewGroup);
    let previewMeshes: THREE.Mesh[] = [];

    const baseColor = new THREE.Color(viewportColors.body);
    const edgeColor = new THREE.Color(viewportColors.edges);
    const selectedColor = new THREE.Color(readThemeColor(container, '--theia-focusBorder', '#007fd4'));

    let meshes: THREE.Mesh[] = [];
    let edgeLines: THREE.Line[] = [];
    let curveLines: THREE.Line[] = [];
    let selectedCurveId: string | undefined;
    let currentSelection: CadSelection = {};
    // Solids hidden through the Model Outline hide/isolate actions; cleared on
    // every new model (solid indices are positional and can shuffle).
    let hiddenSolidIds = new Set<number>();
    let activeFacePickMode: 'sketchDatum' | 'externalGeometry' | undefined;
    let activeDressUpPickMode: { type: FeatureType; selecting: 'edge' | 'face' } | undefined;
    let activeHolePickMode = initialHolePickMode;
    let activeCurvePickMode = initialCurvePickMode;
    /** Curve hovered during curve-pick mode; highlighted like a selection. */
    let curvePickHoverId: string | undefined;
    let lastCenter = new THREE.Vector3();
    let lastDiag = 10;
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

    // Axis navigation gizmo: an SVG overlay that mirrors the
    // camera orientation and snaps to the clicked axis view. Updated directly
    // from renderScene — no React state, so orbiting causes no re-renders.
    const gizmo = document.createElement('div');
    gizmo.className = 'cad-viewport-gizmo';
    // Hidden until a tessellation is on screen; setGizmoVisible owns visibility.
    gizmo.style.display = 'none';
    container.appendChild(gizmo);
    const gizmoRadius = 26;
    const gizmoAxes: Array<{ dir: THREE.Vector3; label: string }> = [
        { dir: new THREE.Vector3(1, 0, 0), label: 'X' },
        { dir: new THREE.Vector3(0, 1, 0), label: 'Y' },
        { dir: new THREE.Vector3(0, 0, 1), label: 'Z' }
    ];
    const updateGizmo = (): void => {
        const size = gizmoRadius * 2 + 16;
        const c = size / 2;
        const inverse = camera.quaternion.clone().invert();
        const handles = gizmoAxes
            .flatMap(({ dir, label }) => [
                {
                    v: dir.clone().applyQuaternion(inverse),
                    label,
                    d: dir.toArray() as [number, number, number],
                    positive: true
                },
                {
                    v: dir.clone().negate().applyQuaternion(inverse),
                    label,
                    d: dir.clone().negate().toArray() as [number, number, number],
                    positive: false
                }
            ])
            .map((h) => ({
                ...h,
                x: c + h.v.x * gizmoRadius,
                y: c - h.v.y * gizmoRadius,
                depth: h.v.z
            }))
            .sort((a, b) => a.depth - b.depth);
        const parts: string[] = [];
        for (const h of handles) {
            if (h.positive) {
                parts.push(
                    `<line x1='${c}' y1='${c}' x2='${h.x.toFixed(1)}' y2='${h.y.toFixed(1)}' stroke='var(--theia-descriptionForeground)' stroke-width='1.2'/>`
                );
            }
        }
        for (const h of handles) {
            const fill = h.positive ? 'var(--theia-focusBorder)' : 'var(--theia-editorWidget-background)';
            const textFill = h.positive ? 'var(--theia-button-foreground)' : 'var(--theia-descriptionForeground)';
            const r = h.positive ? 8 : 6.5;
            parts.push(
                `<circle cx='${h.x.toFixed(1)}' cy='${h.y.toFixed(1)}' r='${r}' fill='${fill}' stroke='var(--theia-descriptionForeground)' stroke-width='1' data-dir='${h.d.join(',')}'/>` +
                    `<text x='${h.x.toFixed(1)}' y='${(h.y + 3).toFixed(1)}' text-anchor='middle' font-size='8' fill='${textFill}' style='pointer-events:none'>${h.label}</text>`
            );
        }
        gizmo.innerHTML = `<svg width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>${parts.join('')}</svg>`;
    };
    gizmo.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        const dir = target?.dataset?.dir;
        if (dir !== undefined) {
            setViewDirection(dir.split(',').map(Number) as [number, number, number]);
        }
    });
    // View label overlay: like the gizmo,
    // updated imperatively from renderScene — never React state.
    const viewLabel = document.createElement('div');
    viewLabel.className = 'cad-viewport-view-label';
    viewLabel.style.display = 'none';
    container.appendChild(viewLabel);
    let viewName = 'User';
    let lastViewLabelText = '';
    // Maps a normalized camera direction to its standard-view name.
    const viewNameForDirection = (dir: [number, number, number]): string => {
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
    const updateViewLabel = (): void => {
        const text = controller.isActive ? `Sketch — ${controller.getSketchName()}` : `${viewName} view`;
        if (text !== lastViewLabelText) {
            lastViewLabelText = text;
            viewLabel.textContent = text;
        }
    };
    const setGizmoVisible = (visible: boolean): void => {
        gizmo.style.display = visible ? '' : 'none';
        viewLabel.style.display = visible ? '' : 'none';
    };

    // Measure tool overlays: measurement lines and endpoint spheres live in a
    // scene-level group (never the model group, so rebuilds don't dispose them
    // implicitly), and their distance labels are imperative DOM positioned on
    // every renderScene exactly like the gizmo and view label — no React state,
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
            label.textContent = formatMeasureDistance(measurement.distance);
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
            label.textContent = formatMeasureAngle(measurement.angle);
            measureGroup.add(lineBA, lineBC, sphereA, sphereB, sphereC);
            return { type: 'angle', measurement, lineBA, lineBC, sphereA, sphereB, sphereC, label };
        }
        const sphereCenter = makeMeasureSphere();
        sphereCenter.position.set(measurement.center[0], measurement.center[1], measurement.center[2]);
        label.textContent = formatMeasureRadius(measurement.radius);
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
            visual.label.textContent = formatMeasureDistance(measurement.distance);
            return;
        }
        if (visual.type === 'angle' && isMeasureAngle(measurement)) {
            visual.measurement = measurement;
            setMeasureLinePoints(visual.lineBA, measurement.b, measurement.a);
            setMeasureLinePoints(visual.lineBC, measurement.b, measurement.c);
            visual.sphereA.position.set(measurement.a[0], measurement.a[1], measurement.a[2]);
            visual.sphereB.position.set(measurement.b[0], measurement.b[1], measurement.b[2]);
            visual.sphereC.position.set(measurement.c[0], measurement.c[1], measurement.c[2]);
            visual.label.textContent = formatMeasureAngle(measurement.angle);
            return;
        }
        if (visual.type === 'radius' && isMeasureRadius(measurement)) {
            visual.measurement = measurement;
            visual.sphereCenter.position.set(measurement.center[0], measurement.center[1], measurement.center[2]);
            visual.label.textContent = formatMeasureRadius(measurement.radius);
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
                text = formatMeasureDistance(visual.measurement.distance);
            } else if (visual.type === 'angle') {
                anchor = visual.measurement.b;
                text = formatMeasureAngle(visual.measurement.angle);
            } else {
                anchor = visual.measurement.center;
                text = formatMeasureRadius(visual.measurement.radius);
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
                      positionLabel(pendingLabel, vertex, formatMeasureAngle(measureAngle(pendingPoint, vertex, measureHover)))
                    : positionLabel(
                          pendingLabel,
                          measureHover ?? pendingPoint,
                          measureHover !== undefined && measureState.tool === 'distance'
                              ? formatMeasureDistance(measureDistance(pendingPoint, measureHover))
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
        // Camera matrices must be fresh before the overlay projection math, and
        // the overlays must be updated BEFORE the paint: with render-on-demand
        // there is no next frame to correct a stale one, so painting first would
        // flash newly created measure markers at their initial unit scale.
        cam.updateMatrixWorld();
        updateMeasureOverlays();
        renderer.render(scene, cam);
        updateGizmo();
        updateViewLabel();
    };
    controller = new SketchModeController(container, scene, renderer, controls, renderScene, {
        modelGroup,
        messageService,
        documentStore,
        mainCamera: camera
    });
    onControllerReady(controller, camera);

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
            const material = isSelected ? highlightMaterial : bodyMaterial;
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
        // Flags are role-wide: every body face shares the two materials, so the
        // shading mode lands on the materials directly; per-mesh state is
        // visibility only (plus hidden solids).
        for (const material of [bodyMaterial, highlightMaterial]) {
            material.wireframe = flags.wireframe;
            material.transparent = flags.transparent;
            material.opacity = flags.opacity;
            material.depthWrite = flags.depthWrite;
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
                mesh.geometry.dispose();
            }
        }
        meshPool = new Map();
        meshes = [];
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

    const buildModel = (data?: TessData): void => {
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
            explodeCentroids = undefined;
            applyExplode();
            applyShading();
            return;
        }

        const bbox = data.boundingBox;
        const center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
        const diag = new THREE.Vector3(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]).length();
        lastCenter.copy(center);
        lastDiag = diag;
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
                fingerprint: face.fingerprint
            };
            adopt(mesh, key);
        }
        // Leftover pooled meshes served faces that vanished from the payload.
        for (const bucket of meshPool.values()) {
            for (const mesh of bucket) {
                modelGroup.remove(mesh);
                mesh.geometry.dispose();
            }
        }
        meshPool = nextPool;
        meshes = nextMeshes;

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
        controls.update();
    };

    const setViewDirection = (dir: [number, number, number]): void => {
        viewName = viewNameForDirection(dir);
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

    const setShading = (mode: ShadingMode): void => {
        shading = mode;
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
    // Any manual orbit/zoom/pan leaves the standard views; the label picks the
    // change up on the next render (OrbitControls fires 'change' throughout).
    const onViewInteractionStart = (): void => {
        viewName = 'User';
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

    const onClick = (event: MouseEvent) => {
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
                    onEdgePick(hit);
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
        if (activeFacePickMode !== undefined) {
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.clear();
                onFacePick(hit);
            }
            return;
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
            onSelect({ solidId: data.solidId as number, faceId: data.faceId as number });
        } else {
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
        if (activeFacePickMode !== undefined || activeDressUpPickMode !== undefined || activeHolePickMode || activeCurvePickMode) {
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

    let closeContextMenu: (() => void) | undefined;
    const onContextMenu = (event: MouseEvent): void => {
        if (activeFacePickMode === undefined && activeDressUpPickMode === undefined && !activeHolePickMode && !activeCurvePickMode) {
            // No pick mode: the viewport's own menu replaces the browser
            // default. Sketch mode keeps the default — the menu is a 3D-model
            // surface — and an empty canvas has nothing to act on.
            if (controller.isActive || meshes.length === 0) {
                return;
            }
            event.preventDefault();
            closeContextMenu?.();
            const rect = renderer.domElement.getBoundingClientRect();
            const ndc = pointerToNdc(event.clientX, event.clientY, rect);
            const hit = raycastFace(pickableMeshes(), raycaster, ndc, camera);
            const featureId = attributeBodyToFeature(hit?.bodyId, documentStore.document?.features);
            const containerRect = container.getBoundingClientRect();
            closeContextMenu = openViewportContextMenu(
                container,
                buildViewportContextMenu({
                    solid: hit !== undefined ? { solidId: hit.solidId, featureId } : undefined,
                    explodeFactor,
                    hiddenCount: hiddenSolidIds.size,
                    sectionActive: isSectionActive()
                }),
                { x: event.clientX - containerRect.left, y: event.clientY - containerRect.top },
                (action) => {
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
                        case 'noop':
                            break;
                    }
                }
            );
            return;
        }
        event.preventDefault();
        closeContextMenu?.();
        closeContextMenu = undefined;
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
        if (!controller.isActive) {
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

    const onFitKey = (event: KeyboardEvent): void => {
        if (!viewportHasFocus()) {
            return;
        }
        if (event.key !== 'f' && event.key !== 'F' && event.key !== '.') {
            return;
        }
        if (
            controller.isActive ||
            activeFacePickMode !== undefined ||
            activeDressUpPickMode !== undefined ||
            activeHolePickMode ||
            activeCurvePickMode
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
        if (activeFacePickMode !== undefined || activeDressUpPickMode !== undefined || activeHolePickMode || activeCurvePickMode) {
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
        onToggleSketchMode();
    };
    window.addEventListener('keydown', onTabKey);

    // Escape exits section mode unless a pick mode, sketch session, dialog, or
    // text field consumes the key first (same guards as the fit/tab keys), and
    // always closes an open bottom-bar popover.
    // Capture phase, for the same Theia keybinding race as onKeyDown.
    const onSectionEscapeKey = (event: KeyboardEvent): void => {
        if (!viewportHasFocus()) {
            return;
        }
        if (event.key !== 'Escape') {
            return;
        }
        if (
            controller.isActive ||
            activeFacePickMode !== undefined ||
            activeDressUpPickMode !== undefined ||
            activeHolePickMode ||
            activeCurvePickMode
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
        setPreviewTessellation,
        fitView,
        zoomView,
        setStandardView,
        setShading,
        setGhostOpacity,
        setViewportBackground,
        setNavigationStyle,
        setSection,
        setExplodeFactor: (factor) => {
            explodeFactor = clampExplodeFactor(factor);
            applyExplode();
            renderScene();
        },
        setGizmoVisible,
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
        cleanup: () => {
            closeContextMenu?.();
            closeContextMenu = undefined;
            container.classList.remove('cad-viewport-gradient');
            gizmo.remove();
            viewLabel.remove();
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
            themeColorsDisposed = true;
            themeDisposable.dispose();
            resizeObserver.disconnect();
            renderer.domElement.removeEventListener('click', onClick);
            renderer.domElement.removeEventListener('dblclick', onDblClick);
            renderer.domElement.removeEventListener('pointermove', onPickPointerMove);
            renderer.domElement.removeEventListener('contextmenu', onContextMenu);
            renderer.domElement.removeEventListener('pointerdown', onPointerDown);
            renderer.domElement.removeEventListener('pointermove', onSketchPointerMove);
            renderer.domElement.removeEventListener('pointerup', onPointerUp);
            renderer.domElement.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKeyDown, true);
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
            for (const mesh of meshes) {
                mesh.geometry.dispose();
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
