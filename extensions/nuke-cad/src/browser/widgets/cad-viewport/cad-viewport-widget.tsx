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

    @inject(MonacoWorkspace)
    protected readonly monacoWorkspace: MonacoWorkspace;

    private tessData?: TessData;
    private loading = false;
    private loadingMessage = 'Loading CAD model...';
    private buildError?: string;
    /** Monotonically increasing token; stale tessellation loads are dropped. */
    private tessLoadToken = 0;
    private saveRebuildTimer?: ReturnType<typeof setTimeout>;

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

    @postConstruct()
    protected init(): void {
        this.id = CadViewportWidget.ID;
        this.title.label = CadViewportWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-globe';

        this.toDispose.push(this.stateManager.onModelChange((model) => this.handleModelChange(model)));
        this.toDispose.push(this.monacoWorkspace.onDidSaveTextDocument((document) => this.onModelScriptSaved(document)));
        this.toDispose.push(Disposable.create(() => this.clearSaveRebuildTimer()));
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
        if (!scriptPath || !scriptPath.toLowerCase().endsWith('.py')) {
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
                'CAD Models': ['py', 'step', 'stp']
            }
        });
        if (!uri) {
            return;
        }

        const filePath = uri.path.toString();
        const ext = uri.path.ext.toLowerCase();
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

    protected render(): React.ReactNode {
        return (
            <CadViewportComponent
                loading={this.loading}
                loadingMessage={this.loadingMessage}
                tessData={this.tessData}
                error={this.buildError}
                onDismissError={this.dismissBuildError}
                onSelect={this.handleViewportSelect}
                subscribeSelection={this.subscribeSelection}
                subscribeThemeChange={this.subscribeThemeChange}
                onOpenModel={() => this.openModel()}
            />
        );
    }
}

interface CadViewportComponentProps {
    readonly loading: boolean;
    readonly loadingMessage: string;
    readonly tessData?: TessData;
    readonly error?: string;
    readonly onDismissError: () => void;
    readonly onSelect: (selection: CadSelection) => void;
    readonly subscribeSelection: (listener: (selection: CadSelection) => void) => Disposable;
    readonly subscribeThemeChange: (listener: () => void) => Disposable;
    readonly onOpenModel: () => void;
}

function CadViewportComponent(props: CadViewportComponentProps): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const container = containerRef.current;
        if (!container || props.tessData === undefined) {
            return undefined;
        }

        const tessData = props.tessData;
        const onSelect = props.onSelect;
        const subscribeSelection = props.subscribeSelection;
        const subscribeThemeChange = props.subscribeThemeChange;
        let disposed = false;
        let cleanup: (() => void) | undefined;

        (async () => {
            const [{ OrbitControls }] = await Promise.all([import('three/examples/jsm/controls/OrbitControls.js')]);
            if (disposed) {
                return;
            }
            cleanup = initViewport(container, tessData, onSelect, subscribeSelection, subscribeThemeChange, OrbitControls);
        })().catch((err) => {
            console.error('[CadViewport] Failed to initialize viewport:', err);
        });

        return () => {
            disposed = true;
            cleanup?.();
        };
        // All non-tessData props are stable widget-bound callbacks; the scene is
        // rebuilt only when a new tessellation arrives.
    }, [props.tessData, props.onSelect, props.subscribeSelection, props.subscribeThemeChange]);

    const errorBanner = props.error ? (
        <div className="cad-viewport-error-banner">
            <span className="codicon codicon-error" />
            <span className="cad-viewport-error-message">{props.error}</span>
            <button className="theia-button secondary cad-viewport-error-dismiss" onClick={props.onDismissError} title="Dismiss">
                <span className="codicon codicon-close" />
            </button>
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

    if (props.tessData === undefined) {
        return (
            <div ref={containerRef} className="cad-viewport empty">
                {errorBanner}
                <LoadingAnimations />
                <div className="cad-viewport-empty-panel">
                    <span className="codicon codicon-globe cad-viewport-empty-icon" />
                    <div className="cad-viewport-empty-title">CAD Viewport</div>
                    <div className="cad-viewport-empty-description">
                        Open a build123d/CadQuery script or a STEP/STP/BREP file to view and inspect geometry.
                    </div>
                    <div className="cad-viewport-empty-formats">Supported formats: .py, .step, .stp, .brep</div>
                    <button className="theia-button open-cad-model-button" onClick={props.onOpenModel}>
                        <span className="codicon codicon-folder-opened" /> Open CAD Model...
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div ref={containerRef} className="cad-viewport">
            {errorBanner}
            {props.loading && (
                <div className="cad-viewport-loading-overlay">
                    <span className="codicon codicon-loading codicon-modifier-spin" />
                    <span>{props.loadingMessage}</span>
                </div>
            )}
        </div>
    );
}

function initViewport(
    container: HTMLDivElement,
    tessData: TessData,
    onSelect: (selection: CadSelection) => void,
    subscribeSelection: (listener: (selection: CadSelection) => void) => Disposable,
    subscribeThemeChange: (listener: () => void) => Disposable,
    OrbitControlsCtor: new (
        camera: THREE.Camera,
        domElement: HTMLElement
    ) => {
        target: THREE.Vector3;
        update: () => void;
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
        dispose(): void;
    }
): () => void {
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 300;

    const scene = new THREE.Scene();
    const background = readThemeColor(container, '--theia-editor-background', '#1e1e1e');
    scene.background = new THREE.Color(background);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
    const bbox = tessData.boundingBox;
    const center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
    const diag = new THREE.Vector3(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]).length();
    camera.position.copy(center.clone().add(new THREE.Vector3(diag, diag, diag)));
    camera.lookAt(center);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControlsCtor(camera, renderer.domElement);
    controls.target.copy(center);
    controls.update();

    const meshes: THREE.Mesh[] = [];
    const group = new THREE.Group();
    scene.add(group);

    const baseColor = new THREE.Color(readThemeColor(container, '--theia-foreground', '#cccccc'));
    const selectedColor = new THREE.Color(readThemeColor(container, '--theia-focusBorder', '#007fd4'));

    for (const solid of tessData.solids) {
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
            group.add(mesh);
            meshes.push(mesh);
        }
    }

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(diag, diag, diag);
    scene.add(directional);

    // Render on demand: the scene is static unless the user orbits, the
    // selection changes, the theme changes, or the container resizes. No
    // animation loop runs while the widget is idle, hidden, or detached.
    const renderScene = (): void => {
        renderer.render(scene, camera);
    };
    controls.addEventListener('change', renderScene);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const onClick = (event: MouseEvent) => {
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

    let currentSelection: CadSelection = {};
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
    });

    const resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
            renderScene();
        }
    });
    resizeObserver.observe(container);

    renderScene();

    return () => {
        selectionDisposable.dispose();
        themeDisposable.dispose();
        resizeObserver.disconnect();
        renderer.domElement.removeEventListener('click', onClick);
        controls.removeEventListener('change', renderScene);
        controls.dispose();
        renderer.dispose();
        if (renderer.domElement.parentElement === container) {
            container.removeChild(renderer.domElement);
        }
        for (const mesh of meshes) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
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
