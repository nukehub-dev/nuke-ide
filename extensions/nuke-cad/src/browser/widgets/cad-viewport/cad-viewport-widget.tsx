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
import { type NukeCadDocument, type SketchDef, type FeatureDef, type FeatureType, type FeatureParams } from '../../../common/cad-document';
import './cad-viewport.css';

interface TessFace {
    readonly faceId: number;
    readonly nodes: number[][];
    readonly triangles: number[][];
}

interface TessSolid {
    readonly solidId: number;
    readonly faces: TessFace[];
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
    private saveRebuildTimer?: ReturnType<typeof setTimeout>;

    /** True while the datum picker is waiting for the user to choose a plane. */
    sketchSetupVisible = false;
    /** True while a feature creation dialog is open. */
    featureCreationType?: FeatureType;
    private sketchController?: SketchModeController;
    private sketchCamera?: THREE.PerspectiveCamera;
    /** Id of the sketch being edited, or undefined for a new sketch. */
    private editingSketchId?: string;

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
        const sketchId = this.documentStore.selection.selectedSketchId;
        if (sketchId === undefined) {
            this.messageService.warn('Select a closed sketch before adding a solid feature.');
            return;
        }
        const dependsOn = computeDependsOn(type, doc.features);
        if ((type === 'pocket' || type === 'groove') && dependsOn === undefined) {
            this.messageService.warn(`${type} requires an existing solid body.`);
            return;
        }
        const paramsRecord = params as Record<string, unknown>;
        const label = typeof paramsRecord.label === 'string' ? paramsRecord.label : undefined;
        const featureParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(paramsRecord)) {
            if (key !== 'label') {
                featureParams[key] = value;
            }
        }
        const feature: FeatureDef = {
            id: createFeatureId(),
            name: `${type} ${doc.features.length + 1}`,
            type,
            sketchId,
            params: featureParams as FeatureParams,
            suppressed: false,
            label,
            dependsOn: dependsOn !== undefined ? [dependsOn] : []
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
        if (this.documentStore.selection.selectedSketchId === undefined) {
            this.messageService.warn('Select a closed sketch in the feature tree before adding a solid feature.');
            return;
        }
        this.featureCreationType = type;
        this.update();
    }

    /** Rebuild the active document through the backend. */
    async rebuildDocument(): Promise<void> {
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

    private async doEnterSketch(kind: DatumKind, offset: number): Promise<void> {
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
            const builtInId = this.datumIdForKind(kind);
            if (offset === 0 && builtInId !== undefined) {
                datumId = builtInId;
            } else {
                datumId = this.ensureOffsetDatum(doc, kind, offset);
            }
        }
        if (datumId === undefined) {
            this.messageService.error(`Could not resolve datum for ${kind} offset ${offset}`);
            return;
        }
        const sketchDef: SketchDef | undefined =
            existingSketch !== undefined
                ? { ...existingSketch }
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
            this.documentStore.upsertSketch(sketchDef);
        }
        this.editingSketchId = sketchDef.id;
        const inheritedParameters = { ...doc.parameters };
        await this.sketchController?.enterSketch(
            kind,
            offset,
            this.sketchCamera,
            existingSketch !== undefined ? sketchDef : undefined,
            inheritedParameters
        );
    }

    private datumIdForKind(kind: DatumKind): string | undefined {
        const map: Record<string, string> = { XY: 'datum-xy', YZ: 'datum-yz', XZ: 'datum-xz' };
        return map[kind];
    }

    private ensureOffsetDatum(doc: NukeCadDocument, kind: DatumKind, offset: number): string {
        const existing = doc.datums.find((d) => d.kind === kind && d.offset === offset);
        if (existing !== undefined) {
            return existing.id;
        }
        const id = `datum-${kind.toLowerCase()}-offset-${Date.now()}`;
        const nextDoc: NukeCadDocument = {
            ...doc,
            datums: [...doc.datums, { id, kind, name: `${kind} Offset ${offset}`, offset }]
        };
        this.documentStore.loadDocument(nextDoc);
        return id;
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
        this.scheduleDocumentRebuild();
    }

    private scheduleDocumentRebuild(): void {
        if (!this.documentStore.hasDocument) {
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
                    this.update();
                }}
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
    readonly documentStore: CadDocumentStore;
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
}

function CadViewportComponent(props: CadViewportComponentProps): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [controller, setController] = React.useState<SketchModeController | undefined>();
    const viewportApi = React.useRef<{ updateModel?: (tessData?: TessData) => void }>({});

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
                props.onSelect,
                props.subscribeSelection,
                props.subscribeThemeChange,
                props.onControllerReady,
                OrbitControls
            );
            if (disposed) {
                api.cleanup();
                return;
            }
            cleanup = api.cleanup;
            viewportApi.current.updateModel = api.updateModel;
            setController(api.controller);
        })().catch((err) => {
            console.error('[CadViewport] Failed to initialize viewport:', err);
        });

        return () => {
            disposed = true;
            viewportApi.current.updateModel = undefined;
            cleanup?.();
        };
        // All non-tessData props are stable widget-bound callbacks; the scene is
        // rebuilt only when a new tessellation arrives.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    React.useEffect(() => {
        viewportApi.current.updateModel?.(props.tessData);
    }, [props.tessData, controller]);

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
                        onEnterSketch={props.onEnterSketch}
                        onExitSketch={props.onExitSketch}
                        onStartFeatureCreation={props.onStartFeatureCreation}
                        onAddFeature={props.onAddFeature}
                        onEditSketch={props.onEditSketch}
                        onCancelFeatureCreation={props.onCancelFeatureCreation}
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
                    onEnterSketch={props.onEnterSketch}
                    onExitSketch={props.onExitSketch}
                    onStartFeatureCreation={props.onStartFeatureCreation}
                    onAddFeature={props.onAddFeature}
                    onEditSketch={props.onEditSketch}
                    onCancelFeatureCreation={props.onCancelFeatureCreation}
                />
            )}
        </div>
    );
}

interface ViewportApi {
    readonly controller: SketchModeController;
    readonly cleanup: () => void;
    readonly updateModel: (tessData?: TessData) => void;
}

function initViewport(
    container: HTMLDivElement,
    tessData: TessData | undefined,
    onSelect: (selection: CadSelection) => void,
    subscribeSelection: (listener: (selection: CadSelection) => void) => Disposable,
    subscribeThemeChange: (listener: () => void) => Disposable,
    onControllerReady: (controller: SketchModeController, camera: THREE.PerspectiveCamera) => void,
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
    let currentSelection: CadSelection = {};

    let controller: SketchModeController;
    const renderScene = (): void => {
        renderer.render(scene, controller.getActiveCamera());
    };
    controller = new SketchModeController(container, scene, renderer, controls, renderScene, { modelGroup });
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
                mesh.userData = { solidId: solid.solidId, faceId: face.faceId };
                modelGroup.add(mesh);
                meshes.push(mesh);
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
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
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

    const onPointerDown = (event: PointerEvent): void => {
        if (!controller.isActive) {
            return;
        }
        controller.onPointerDown(event.clientX, event.clientY, event.shiftKey, event.button);
    };
    const onPointerMove = (event: PointerEvent): void => {
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
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    const onKeyDown = (event: KeyboardEvent): void => {
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
        cleanup: () => {
            selectionDisposable.dispose();
            themeDisposable.dispose();
            resizeObserver.disconnect();
            renderer.domElement.removeEventListener('click', onClick);
            renderer.domElement.removeEventListener('pointerdown', onPointerDown);
            renderer.domElement.removeEventListener('pointermove', onPointerMove);
            renderer.domElement.removeEventListener('pointerup', onPointerUp);
            renderer.domElement.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKeyDown);
            controls.removeEventListener('change', renderScene);
            controls.dispose();
            controller.dispose();
            renderer.dispose();
            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }
            for (const mesh of meshes) {
                mesh.geometry.dispose();
                (mesh.material as THREE.Material).dispose();
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
