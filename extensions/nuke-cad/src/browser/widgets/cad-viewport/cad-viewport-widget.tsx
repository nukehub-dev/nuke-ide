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
import { NukeCadCommands } from '../../commands';
import { LoadingAnimations, FancyLoadingSpinner } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import { SketchModeController } from '../../sketch/sketch-mode-controller';
import { type DatumKind } from '../../sketch/sketch-math';
import { CadSketchOverlay } from './cad-sketch-overlay';
import { CadDocumentStore, createSketchId, createFeatureId, computeDependsOn } from '../../document/cad-document-store';
import { type SketchDef, type FeatureDef, type FeatureType, type FeatureParams } from '../../../common/cad-document';
import { type TopologyRef } from '../../../common/topology-refs';
import { FaceHighlighter, type FacePickHit, buildTopologyRef, pointerToNdc, projectHitToFaceUv, raycastFace } from './face-picker';
import { EdgeHighlighter, type EdgePickHit, buildEdgeLine, buildEdgeTopologyRef, raycastEdge } from './edge-picker';
import './cad-viewport.css';

interface TessFace {
    readonly faceId: number;
    readonly nodes: number[][];
    readonly triangles: number[][];
    readonly bodyId?: string;
    readonly fingerprint?: import('../../../common/topology-refs').FaceFingerprint;
}

interface TessEdge {
    readonly edgeId: number;
    readonly points: number[][];
    readonly bodyId?: string;
    readonly fingerprint?: import('../../../common/topology-refs').EdgeFingerprint;
}

interface TessSolid {
    readonly solidId: number;
    readonly bodyId?: string;
    readonly faces: TessFace[];
    readonly edges: TessEdge[];
}

interface TessData {
    readonly version: number;
    readonly tolerance: number;
    readonly boundingBox: { readonly min: number[]; readonly max: number[] };
    readonly solids: TessSolid[];
}

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

    private tessData?: TessData;
    private loading = false;
    private loadingMessage = 'Loading CAD model...';
    private buildError?: string;
    /** Monotonically increasing token; stale tessellation loads are dropped. */
    private tessLoadToken = 0;
    /** Path of the tessellation currently rendered; used to skip redundant reloads. */
    private loadedTessPath?: string;
    private saveRebuildTimer?: ReturnType<typeof setTimeout>;
    /** In-flight rebuild promise; new edits queue exactly one follow-up rebuild. */
    private rebuildPromise?: Promise<void>;
    /** True when an edit arrived while a rebuild was in-flight. */
    private rebuildPending = false;

    /** True while the datum picker is waiting for the user to choose a plane. */
    sketchSetupVisible = false;
    /** True while a feature creation dialog is open. */
    featureCreationType?: FeatureType;
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

    protected readonly subscribeThemeChange = (listener: () => void): Disposable => this.themeService.onDidColorThemeChange(listener);

    protected readonly dismissBuildError = (): void => {
        this.buildError = undefined;
        this.update();
    };

    protected readonly handleControllerReady = (controller: SketchModeController, camera: THREE.PerspectiveCamera): void => {
        this.sketchController = controller;
        this.sketchCamera = camera;
    };

    protected readonly handleEnterSketch = (kind: DatumKind, offset: number): void => {
        this.sketchSetupVisible = false;
        this.update();
        void this.doEnterSketch(kind, offset);
    };

    protected readonly handleExitSketch = (): Promise<void> => this.doExitSketch();

    protected readonly handleNewDocument = (): void => {
        this.documentStore.createDocument('Untitled');
        this.editingSketchId = undefined;
    };

    protected readonly handleSaveDocument = (): Promise<void> => this.saveDocument(false);

    protected readonly handleSaveDocumentAs = (): Promise<void> => this.saveDocument(true);

    protected readonly handleAddFeature = (type: FeatureType, params: FeatureParams): void => {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return;
        }
        const paramsRecord = params as Record<string, unknown>;

        // Boolean, dress-up, pattern/mirror/hole features do not consume a sketch.
        const isBoolean = type === 'booleanFuse' || type === 'booleanCut' || type === 'booleanCommon';
        const isDressUp = type === 'fillet' || type === 'chamfer' || type === 'draft' || type === 'shell';
        const isPatternOrMirrorOrHole = type === 'linearPattern' || type === 'circularPattern' || type === 'mirror' || type === 'hole';
        const sketchId = isBoolean || isDressUp || isPatternOrMirrorOrHole ? undefined : this.documentStore.selection.selectedSketchId;
        if (!isBoolean && !isDressUp && !isPatternOrMirrorOrHole && sketchId === undefined) {
            this.messageService.warn('Select a closed sketch before adding a solid feature.');
            return;
        }

        let bodyId: string | undefined;
        if (isBoolean) {
            bodyId = typeof paramsRecord.targetBody === 'string' ? paramsRecord.targetBody : undefined;
        } else {
            bodyId = typeof paramsRecord.bodyId === 'string' ? paramsRecord.bodyId : undefined;
        }

        const isAdditive = type === 'pad' || type === 'revolve';
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
        this.scheduleDocumentRebuild();
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
            'fillet',
            'chamfer',
            'draft',
            'shell',
            'mirror',
            'linearPattern',
            'circularPattern',
            'hole',
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

    protected readonly handleRebuildDocument = (): Promise<void> => this.rebuildDocument();

    @postConstruct()
    protected init(): void {
        this.id = CadViewportWidget.ID;
        this.title.label = CadViewportWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-globe';

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
            uri = await this.fileDialogService.showSaveDialog({
                title: 'Save CAD Document',
                filters: { 'CAD Document': ['nuke-cad'] }
            });
            if (uri === undefined) {
                return;
            }
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
        if (!isBoolean && !isDressUp && !isPatternOrMirrorOrHole && this.documentStore.selection.selectedSketchId === undefined) {
            this.messageService.warn('Select a closed sketch in the feature tree before adding a solid feature.');
            return;
        }
        this.featureCreationType = type;
        this.update();
    }

    /** Rebuild the active document through the backend. */
    async rebuildDocument(): Promise<void> {
        if (this.rebuildPromise !== undefined) {
            this.rebuildPending = true;
            return;
        }
        this.rebuildPromise = this.doRebuildDocument();
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

    private async doRebuildDocument(): Promise<void> {
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
        this.setLoading(true, 'Rebuilding CAD geometry...');
        try {
            const result = await this.backendService.buildDocument({ scriptPath: filePath });
            this.documentStore.setFeatureResults(result.featureResults ?? []);
            this.documentStore.setProjectedPrimitives(result.projectedPrimitives);
            this.documentStore.setReferenceResults(result.referenceResults ?? []);
            if (result.success) {
                this.stateManager.setModel({ scriptPath: filePath, result, manifest: result.regionManifest });
                this.messageService.info(`CAD rebuild: ${result.solidCount ?? 0} solids, ${result.triangleCount ?? 0} triangles`);
            } else {
                const message = result.error || 'Document rebuild failed.';
                this.showBuildError(message);
                this.messageService.error(message);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.showBuildError(message);
            this.messageService.error(message);
        }
    }

    private async doEnterSketch(kind: DatumKind, offset: number, reference?: TopologyRef): Promise<void> {
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
                const datumResult = this.documentStore.addDatum(kind, offset, reference);
                if (!datumResult.success) {
                    this.showBuildError(datumResult.error || 'Failed to create datum.');
                    this.messageService.error(datumResult.error || 'Failed to create datum.');
                    this.sketchSetupVisible = false;
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
                existingSketch !== undefined ? sketchDef : undefined,
                inheritedParameters,
                reference
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.showBuildError(`Failed to start sketch solver: ${message}`);
            this.messageService.error(`Failed to start sketch solver: ${message}`);
            this.sketchSetupVisible = false;
            this.facePickMode = undefined;
            this.editingSketchId = undefined;
            this.update();
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
        this.scheduleDocumentRebuild();
    }

    private scheduleDocumentRebuild(): void {
        if (!this.documentStore.hasDocument) {
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
        this.update();
    }

    /** Show a loading indicator over the current geometry while a rebuild runs. */
    setLoading(loading: boolean, message = 'Rebuilding CAD geometry...'): void {
        if (loading) {
            // Invalidate any in-flight tessellation load; a rebuild supersedes it.
            this.tessLoadToken++;
            this.loadingMessage = message;
            this.buildError = undefined;
        }
        this.loading = loading;
        this.update();
    }

    /** Surface a build failure as a dismissible banner inside the viewport. */
    showBuildError(message: string): void {
        this.loading = false;
        this.buildError = message;
        this.update();
    }

    private handleModelChange(model: CadModel | undefined): void {
        const tessPath = model?.result.tessPath;
        const token = ++this.tessLoadToken;
        if (!tessPath) {
            this.tessData = undefined;
            this.loadedTessPath = undefined;
            this.loading = false;
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
        this.update();
        this.loadTessellation(tessPath, token).catch((err) => {
            console.error('[CadViewport] Failed to load tessellation:', err);
            if (token === this.tessLoadToken) {
                this.loading = false;
                this.buildError = err instanceof Error ? err.message : String(err);
                this.update();
            }
        });
    }

    private async loadTessellation(path: string, token: number): Promise<void> {
        const content = await this.fileService.readFile(new URI(path));
        if (token !== this.tessLoadToken) {
            return; // A newer model or rebuild superseded this load.
        }
        this.tessData = JSON.parse(content.value.toString()) as TessData;
        this.loadedTessPath = path;
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

        this.loading = true;
        this.loadingMessage = sourceType === 'step' ? 'Importing STEP file...' : 'Building CAD geometry...';
        this.buildError = undefined;
        this.update();

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
            this.loading = false;
            this.update();
        }
    }

    private async openDocumentModel(uri: URI, filePath: string): Promise<void> {
        this.loading = true;
        this.loadingMessage = 'Loading CAD document...';
        this.buildError = undefined;
        this.update();
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
            await this.rebuildDocument();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.buildError = message;
            this.messageService.error(message);
        } finally {
            this.loading = false;
            this.update();
        }
    }

    protected render(): React.ReactNode {
        return (
            <CadViewportComponent
                loading={this.loading}
                loadingMessage={this.loadingMessage}
                tessData={this.tessData}
                error={this.buildError}
                dirty={this.documentStore.dirty}
                sketchSetupVisible={this.sketchSetupVisible}
                featureCreationType={this.featureCreationType}
                facePickMode={this.facePickMode}
                dressUpPickMode={this.dressUpPickMode}
                documentStore={this.documentStore}
                onDismissError={this.dismissBuildError}
                onSelect={this.handleViewportSelect}
                subscribeSelection={this.subscribeSelection}
                subscribeThemeChange={this.subscribeThemeChange}
                onOpenModel={() => this.openModel()}
                onNewDocument={this.handleNewDocument}
                onSaveDocument={this.handleSaveDocument}
                onRebuildDocument={this.handleRebuildDocument}
                onControllerReady={this.handleControllerReady}
                onEnterSketch={this.handleEnterSketch}
                onExitSketch={this.handleExitSketch}
                onStartFeatureCreation={(type) => this.startFeatureCreation(type)}
                onAddFeature={this.handleAddFeature}
                onEditSketch={this.handleEditSketch}
                onCancelFeatureCreation={() => {
                    this.featureCreationType = undefined;
                    this.dressUpPickMode = undefined;
                    this.dressUpPickCallback = undefined;
                    this.holePickMode = undefined;
                    this.update();
                }}
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
                messageService={this.messageService}
            />
        );
    }
}

interface CadViewportComponentProps {
    readonly loading: boolean;
    readonly loadingMessage: string;
    readonly tessData?: TessData;
    readonly error?: string;
    readonly dirty: boolean;
    readonly sketchSetupVisible: boolean;
    readonly featureCreationType?: FeatureType;
    readonly facePickMode?: 'sketchDatum' | 'externalGeometry';
    readonly dressUpPickMode?: { readonly type: FeatureType; readonly selecting: 'edge' | 'face' };
    readonly holePickMode?: boolean;
    readonly documentStore: CadDocumentStore;
    readonly messageService: MessageService;
    readonly onDismissError: () => void;
    readonly onSelect: (selection: CadSelection) => void;
    readonly subscribeSelection: (listener: (selection: CadSelection) => void) => Disposable;
    readonly subscribeThemeChange: (listener: () => void) => Disposable;
    readonly onOpenModel: () => void;
    readonly onNewDocument: () => void;
    readonly onSaveDocument: () => void;
    readonly onRebuildDocument: () => void;
    readonly onControllerReady: (controller: SketchModeController, camera: THREE.PerspectiveCamera) => void;
    readonly onEnterSketch: (kind: DatumKind, offset: number) => void;
    readonly onExitSketch: () => Promise<void>;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
    readonly onAddFeature: (type: FeatureType, params: FeatureParams) => void;
    readonly onEditSketch: (sketchId: string) => void;
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
}

function CadViewportComponent(props: CadViewportComponentProps): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [controller, setController] = React.useState<SketchModeController | undefined>();
    const viewportApi = React.useRef<{
        updateModel?: (tessData?: TessData) => void;
        setFacePickMode?: (mode?: 'sketchDatum' | 'externalGeometry') => void;
        setDressUpPickMode?: (mode?: { type: FeatureType; selecting: 'edge' | 'face' }) => void;
        setHolePickMode?: (active: boolean) => void;
    }>({});

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
                props.messageService,
                OrbitControls
            );
            if (disposed) {
                api.cleanup();
                return;
            }
            cleanup = api.cleanup;
            viewportApi.current.updateModel = api.updateModel;
            viewportApi.current.setFacePickMode = api.setFacePickMode;
            viewportApi.current.setDressUpPickMode = api.setDressUpPickMode;
            viewportApi.current.setHolePickMode = api.setHolePickMode;
            api.setFacePickMode(props.facePickMode);
            api.setDressUpPickMode(props.dressUpPickMode);
            api.setHolePickMode(props.holePickMode ?? false);
            setController(api.controller);
        })().catch((err) => {
            console.error('[CadViewport] Failed to initialize viewport:', err);
        });

        return () => {
            disposed = true;
            viewportApi.current.updateModel = undefined;
            viewportApi.current.setFacePickMode = undefined;
            viewportApi.current.setDressUpPickMode = undefined;
            viewportApi.current.setHolePickMode = undefined;
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

    if (props.loading && props.tessData === undefined) {
        return (
            <div className="cad-viewport loading">
                {errorBanner}
                <LoadingAnimations />
                <FancyLoadingSpinner message={props.loadingMessage} subMessage="This may take a moment for large models" />
            </div>
        );
    }

    const documentEmpty = props.tessData === undefined && props.documentStore.hasDocument;
    const dirtyMarker = props.dirty ? <span className="cad-viewport-dirty-marker" title="Unsaved changes" /> : null;

    if (props.tessData === undefined) {
        return (
            <div ref={containerRef} className="cad-viewport empty">
                {errorBanner}
                {dirtyMarker}
                <LoadingAnimations />
                <div className="cad-viewport-empty-panel">
                    <span className="codicon codicon-globe cad-viewport-empty-icon" />
                    <div className="cad-viewport-empty-title">CAD Viewport</div>
                    <div className="cad-viewport-empty-description">
                        Open a build123d/CadQuery script, a STEP/STP/BREP file, or a .nuke-cad document to view and inspect geometry.
                    </div>
                    <div className="cad-viewport-empty-formats">Supported formats: .py, .step, .stp, .brep, .nuke-cad</div>
                    <div className="cad-viewport-empty-actions">
                        <button className="theia-button" onClick={props.onNewDocument}>
                            <span className="codicon codicon-new-file" /> New Document
                        </button>
                        <button className="theia-button secondary open-cad-model-button" onClick={props.onOpenModel}>
                            <span className="codicon codicon-folder-opened" /> Open CAD Model...
                        </button>
                    </div>
                </div>
                {controller !== undefined && (
                    <CadSketchOverlay
                        controller={controller}
                        documentStore={props.documentStore}
                        setupVisible={props.sketchSetupVisible}
                        featureCreationType={props.featureCreationType}
                        facePickMode={props.facePickMode}
                        dressUpPickMode={props.dressUpPickMode}
                        holePickMode={props.holePickMode}
                        onEnterSketch={props.onEnterSketch}
                        onExitSketch={props.onExitSketch}
                        onStartFeatureCreation={props.onStartFeatureCreation}
                        onAddFeature={props.onAddFeature}
                        onEditSketch={props.onEditSketch}
                        onCancelFeatureCreation={props.onCancelFeatureCreation}
                        onStartFacePick={props.onStartFacePick}
                        onStartExternalGeometryPick={props.onStartExternalGeometryPick}
                        onCancelFacePick={props.onFacePickCancel}
                        onStartDressUpPick={props.onStartDressUpPick}
                        onDressUpPickCancel={props.onDressUpPickCancel}
                        onStartHolePick={props.onStartHolePick}
                        onHolePickCancel={props.onHolePickCancel}
                    />
                )}
            </div>
        );
    }

    return (
        <div ref={containerRef} className="cad-viewport">
            {errorBanner}
            {dirtyMarker}
            {props.loading && (
                <div className="cad-viewport-loading-overlay">
                    <span className="codicon codicon-loading codicon-modifier-spin" />
                    <span>{props.loadingMessage}</span>
                </div>
            )}
            {documentEmpty && (
                <div className="cad-viewport-document-hint">
                    <span className="codicon codicon-info" />
                    Document mode: use the Feature Tree to add sketches and features, then rebuild.
                </div>
            )}
            {controller !== undefined && (
                <CadSketchOverlay
                    controller={controller}
                    documentStore={props.documentStore}
                    setupVisible={props.sketchSetupVisible}
                    featureCreationType={props.featureCreationType}
                    facePickMode={props.facePickMode}
                    dressUpPickMode={props.dressUpPickMode}
                    holePickMode={props.holePickMode}
                    onEnterSketch={props.onEnterSketch}
                    onExitSketch={props.onExitSketch}
                    onStartFeatureCreation={props.onStartFeatureCreation}
                    onAddFeature={props.onAddFeature}
                    onEditSketch={props.onEditSketch}
                    onCancelFeatureCreation={props.onCancelFeatureCreation}
                    onStartFacePick={props.onStartFacePick}
                    onStartExternalGeometryPick={props.onStartExternalGeometryPick}
                    onCancelFacePick={props.onFacePickCancel}
                    onStartDressUpPick={props.onStartDressUpPick}
                    onDressUpPickCancel={props.onDressUpPickCancel}
                    onStartHolePick={props.onStartHolePick}
                    onHolePickCancel={props.onHolePickCancel}
                />
            )}
        </div>
    );
}

interface ViewportApi {
    readonly controller: SketchModeController;
    readonly cleanup: () => void;
    readonly updateModel: (tessData?: TessData) => void;
    readonly setFacePickMode: (mode?: 'sketchDatum' | 'externalGeometry') => void;
    readonly setDressUpPickMode: (mode?: { type: FeatureType; selecting: 'edge' | 'face' }) => void;
    readonly setHolePickMode: (active: boolean) => void;
}

function initViewport(
    container: HTMLDivElement,
    tessData: TessData | undefined,
    documentStore: CadDocumentStore,
    onSelect: (selection: CadSelection) => void,
    subscribeSelection: (listener: (selection: CadSelection) => void) => Disposable,
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
    messageService: MessageService,
    OrbitControlsCtor: new (
        camera: THREE.Camera,
        domElement: HTMLElement
    ) => {
        enabled: boolean;
        target: THREE.Vector3;
        update: () => void;
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
        dispose(): void;
    }
): ViewportApi {
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 300;

    const scene = new THREE.Scene();
    const background = readThemeColor(container, '--theia-editor-background', '#1e1e1e');
    scene.background = new THREE.Color(background);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
    camera.name = 'cad-perspective-camera';
    camera.position.set(10, 10, 10);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControlsCtor(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.update();

    const modelGroup = new THREE.Group();
    modelGroup.name = 'cad-model';
    scene.add(modelGroup);

    const baseColor = new THREE.Color(readThemeColor(container, '--theia-foreground', '#cccccc'));
    const selectedColor = new THREE.Color(readThemeColor(container, '--theia-focusBorder', '#007fd4'));

    let meshes: THREE.Mesh[] = [];
    let edgeLines: THREE.Line[] = [];
    let currentSelection: CadSelection = {};
    let activeFacePickMode: 'sketchDatum' | 'externalGeometry' | undefined;
    let activeDressUpPickMode: { type: FeatureType; selecting: 'edge' | 'face' } | undefined;
    let activeHolePickMode = initialHolePickMode;

    const highlightColor = new THREE.Color(readThemeColor(container, '--theia-focusBorder', '#007fd4'));
    const faceHighlighter = new FaceHighlighter(highlightColor);
    faceHighlighter.attach(modelGroup);
    const edgeHighlighter = new EdgeHighlighter(highlightColor);
    edgeHighlighter.attach(modelGroup);

    let controller: SketchModeController;
    const renderScene = (): void => {
        renderer.render(scene, controller.getActiveCamera());
    };
    controller = new SketchModeController(container, scene, renderer, controls, renderScene, { modelGroup, messageService, documentStore });
    onControllerReady(controller, camera);

    const applyHighlight = (): void => {
        for (const mesh of meshes) {
            const data = mesh.userData;
            // A selection with only a solidId (outline-panel row click) highlights
            // every face of the solid; a viewport pick stays face-precise.
            const isSelected =
                currentSelection.solidId !== undefined &&
                data.solidId === currentSelection.solidId &&
                (currentSelection.faceId === undefined || data.faceId === currentSelection.faceId);
            (mesh.material as THREE.MeshStandardMaterial).color.copy(isSelected ? selectedColor : baseColor);
        }
        renderScene();
    };

    const buildModel = (data?: TessData): void => {
        for (const mesh of meshes) {
            modelGroup.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
        }
        meshes = [];
        for (const line of edgeLines) {
            modelGroup.remove(line);
            line.geometry.dispose();
            (line.material as THREE.Material).dispose();
        }
        edgeLines = [];
        faceHighlighter.clear();
        edgeHighlighter.clear();

        if (data === undefined) {
            applyHighlight();
            return;
        }

        const bbox = data.boundingBox;
        const center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
        const diag = new THREE.Vector3(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]).length();
        camera.position.copy(center.clone().add(new THREE.Vector3(diag, diag, diag)));
        camera.lookAt(center);
        controls.target.copy(center);
        controls.update();

        for (const solid of data.solids) {
            for (const face of solid.faces) {
                const geometry = buildFaceGeometry(face);
                const material = new THREE.MeshStandardMaterial({
                    color: baseColor,
                    roughness: 0.6,
                    metalness: 0.1,
                    side: THREE.DoubleSide
                });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.userData = {
                    solidId: solid.solidId,
                    faceId: face.faceId,
                    bodyId: face.bodyId ?? solid.bodyId,
                    fingerprint: face.fingerprint
                };
                modelGroup.add(mesh);
                meshes.push(mesh);
            }
            for (const edge of solid.edges) {
                const line = buildEdgeLine(solid.solidId, edge);
                modelGroup.add(line);
                edgeLines.push(line);
            }
        }
        applyHighlight();
    };

    buildModel(tessData);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(10, 10, 10);
    scene.add(directional);

    // Render on demand: the scene is static unless the user orbits, the
    // selection changes, the theme changes, or the container resizes. No
    // animation loop runs while the widget is idle, hidden, or detached.
    controls.addEventListener('change', renderScene);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const onClick = (event: MouseEvent) => {
        if (controller.isActive) {
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = pointerToNdc(event.clientX, event.clientY, rect);
        if (activeDressUpPickMode !== undefined) {
            if (activeDressUpPickMode.selecting === 'edge') {
                const hit = raycastEdge(edgeLines, raycaster, ndc, camera);
                if (hit !== undefined) {
                    edgeHighlighter.clear();
                    onEdgePick(hit);
                }
            } else {
                const hit = raycastFace(meshes, raycaster, ndc, camera);
                if (hit !== undefined) {
                    faceHighlighter.clear();
                    onFacePickDressUp(hit);
                }
            }
            return;
        }
        if (activeHolePickMode) {
            const hit = raycastFace(meshes, raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.clear();
                onHolePick(hit);
            }
            return;
        }
        if (activeFacePickMode !== undefined) {
            const hit = raycastFace(meshes, raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.clear();
                onFacePick(hit);
            }
            return;
        }
        pointer.x = ndc.x;
        pointer.y = ndc.y;
        raycaster.setFromCamera(pointer, camera);
        const intersects = raycaster.intersectObjects(meshes, false);
        if (intersects.length > 0) {
            const data = intersects[0].object.userData;
            onSelect({ solidId: data.solidId as number, faceId: data.faceId as number });
        } else {
            onSelect({});
        }
    };
    renderer.domElement.addEventListener('click', onClick);

    const onPickPointerMove = (event: PointerEvent): void => {
        if (controller.isActive) {
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = pointerToNdc(event.clientX, event.clientY, rect);
        if (activeDressUpPickMode?.selecting === 'edge') {
            const hit = raycastEdge(edgeLines, raycaster, ndc, camera);
            if (hit !== undefined) {
                edgeHighlighter.highlight(hit.line);
            } else {
                edgeHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeDressUpPickMode?.selecting === 'face') {
            const hit = raycastFace(meshes, raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.highlight(hit.mesh);
            } else {
                faceHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeHolePickMode) {
            const hit = raycastFace(meshes, raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.highlight(hit.mesh);
            } else {
                faceHighlighter.clear();
            }
            renderScene();
            return;
        }
        if (activeFacePickMode !== undefined) {
            const hit = raycastFace(meshes, raycaster, ndc, camera);
            if (hit !== undefined) {
                faceHighlighter.highlight(hit.mesh);
            } else {
                faceHighlighter.clear();
            }
            renderScene();
        }
    };
    renderer.domElement.addEventListener('pointermove', onPickPointerMove);

    const onContextMenu = (event: MouseEvent): void => {
        if (activeFacePickMode === undefined && activeDressUpPickMode === undefined && !activeHolePickMode) {
            return;
        }
        event.preventDefault();
        faceHighlighter.clear();
        edgeHighlighter.clear();
        if (activeDressUpPickMode !== undefined) {
            onDressUpPickCancel();
        } else if (activeHolePickMode) {
            onHolePickCancel();
        } else {
            onFacePickCancel();
        }
    };
    renderer.domElement.addEventListener('contextmenu', onContextMenu);

    const onPointerDown = (event: PointerEvent): void => {
        if (!controller.isActive) {
            return;
        }
        controller.onPointerDown(event.clientX, event.clientY, event.shiftKey, event.button);
    };
    const onSketchPointerMove = (event: PointerEvent): void => {
        if (!controller.isActive) {
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

    const onKeyDown = (event: KeyboardEvent): void => {
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
        if (activeFacePickMode !== undefined) {
            if (event.key === 'Escape') {
                event.preventDefault();
                faceHighlighter.clear();
                onFacePickCancel();
            }
            return;
        }
        if (!controller.isActive) {
            return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            controller.onDeleteKey();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            controller.onEscape();
        }
    };
    window.addEventListener('keydown', onKeyDown);

    // Fires immediately with the current selection, then on every change.
    const selectionDisposable = subscribeSelection((selection) => {
        currentSelection = selection;
        applyHighlight();
    });

    const themeDisposable = subscribeThemeChange(() => {
        scene.background = new THREE.Color(readThemeColor(container, '--theia-editor-background', '#1e1e1e'));
        baseColor.set(readThemeColor(container, '--theia-foreground', '#cccccc'));
        selectedColor.set(readThemeColor(container, '--theia-focusBorder', '#007fd4'));
        applyHighlight();
        controller.refreshThemeColors();
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
        cleanup: () => {
            selectionDisposable.dispose();
            themeDisposable.dispose();
            resizeObserver.disconnect();
            renderer.domElement.removeEventListener('click', onClick);
            renderer.domElement.removeEventListener('pointermove', onPickPointerMove);
            renderer.domElement.removeEventListener('contextmenu', onContextMenu);
            renderer.domElement.removeEventListener('pointerdown', onPointerDown);
            renderer.domElement.removeEventListener('pointermove', onSketchPointerMove);
            renderer.domElement.removeEventListener('pointerup', onPointerUp);
            renderer.domElement.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKeyDown);
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
                (mesh.material as THREE.Material).dispose();
            }
            for (const line of edgeLines) {
                line.geometry.dispose();
                (line.material as THREE.Material).dispose();
            }
        }
    };
}

function buildFaceGeometry(face: TessFace): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    // The tessellation already shares nodes across triangles; build an indexed
    // geometry instead of un-indexing to per-triangle vertices.
    const positions = new Float32Array(face.nodes.length * 3);
    for (let i = 0; i < face.nodes.length; i++) {
        positions[i * 3] = face.nodes[i][0];
        positions[i * 3 + 1] = face.nodes[i][1];
        positions[i * 3 + 2] = face.nodes[i][2];
    }
    const indices = new Uint32Array(face.triangles.length * 3);
    for (let i = 0; i < face.triangles.length; i++) {
        indices[i * 3] = face.triangles[i][0];
        indices[i * 3 + 1] = face.triangles[i][1];
        indices[i * 3 + 2] = face.triangles[i][2];
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return geometry;
}

function readThemeColor(element: HTMLElement, variable: string, fallback: string): string {
    const value = getComputedStyle(element).getPropertyValue(variable).trim();
    return value || fallback;
}
