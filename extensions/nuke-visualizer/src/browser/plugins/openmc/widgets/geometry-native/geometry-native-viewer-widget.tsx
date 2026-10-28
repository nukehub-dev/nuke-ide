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

import * as React from 'react';
import * as THREE from 'three';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message, Widget } from '@theia/core/lib/browser';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { getThemeMode } from '@theia/core/lib/common/theme';
import { Emitter, Event } from '@theia/core/lib/common/event';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { Disposable } from '@theia/core/lib/common/disposable';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { ViewBadge, ViewerNavBar } from 'nuke-essentials/lib/theme/browser/components';
import type { ViewerNavAction, ViewCubeHandle } from 'nuke-essentials/lib/theme/browser/components';
import { ViewCube } from 'nuke-essentials/lib/theme/browser/components';
import { ViewerFileActions } from '../viewer-nav-extras';
import {
    buildScreenshotFilename,
    captureRendererScreenshot,
    copyScreenshotDataUrl,
    downloadScreenshotDataUrl,
    type ScreenshotOptions
} from '../../../../viewer-core/canvas-screenshot';
import { ViewerExportMenu } from '../viewer-export-menu';
import {
    ClipAxis,
    ClipPlanesState,
    anyClipEnabled,
    createClipPlanesState,
    setAllClipEnabled,
    toThreePlaneParamsArray
} from '../../../../viewer-core/clip-plane';
import { isViewerContextMenuClick, openViewerContextMenu } from '../../../../viewer-core/viewer-context-menu';
import {
    createOrbitControls,
    standardViewDirection,
    type BoundsCorner,
    type OrbitControlsHandle
} from '../../../../viewer-core/orbit-controls';
import { clampSliderValue, DEFAULT_VIEWER_TOOLBAR_STATE, OPACITY_SPEC } from '../../../../viewer-core/viewer-toolbar-model';
import {
    ViewerSettingsHost,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot,
    viewerSnapDirection
} from '../../../../viewer-settings/viewer-settings-model';
import {
    buildGeometryContextMenuItems,
    cellDisplayName,
    cellEdgeColor,
    cellIdFromMeshName,
    colorForCellOnTheme,
    geometryBounds,
    GeometryNativeCell,
    isDegenerateCell,
    isGeometryCellVisible,
    isGeometryMaterialVisible,
    isVoidMaterial,
    materialNamesInOrder,
    meshNameForCell,
    parseGeometryNativeJson,
    parseGeometryNativeModel
} from './geometry-native-model';
import { CsgOutlineHost, CsgOutlinePatch, CsgOutlineSnapshot } from '../../../../csg-outline/csg-outline-model';
import { readVtkText } from '../native-vtk/native-vtk-data';
import '../output-viewer.css';

/**
 * Props driving the native geometry viewer. Every field applies instantly to
 * the already-loaded cells — selecting, hiding materials, changing opacity,
 * or moving the clip planes never restarts anything (there is no trame
 * server; this is the P3-D2 replacement for the `geometry_viz.py` CSG
 * multiblock server and the `openmc-geometry-3d-widget.tsx` iframe).
 */
export interface GeometryNativeViewerProps {
    /** Highlighted cell id (tree↔3D sync key); null clears the highlight. */
    selectedCellId?: number | null;
    /** Material opacity in [0, 1]. */
    opacity?: number;
    /** Per-axis clip state; each enabled axis plane applies (box-section view). */
    clip?: ClipPlanesState;
    /** Materials hidden in the 3D view (tree still lists them). */
    hiddenMaterials?: string[];
}

/** Canvas backdrop of `output-viewer.css` (`--theia-editor-background` in the shipped themes). */
const DEFAULT_VIEWER_BACKGROUND = '#1e1e1e';

/**
 * Native geometry viewer widget (P3-D2): renders CSG cells from the P3-D1
 * JSON extractor shape as three.js box meshes — one box per cell bbox,
 * colored per material — directly in the IDE with no trame server, no
 * reverse proxy, no iframe. The model arrives via `setModelJson` (validated
 * extractor payload; extras ignored) or `setModelFile` (FileService JSON
 * read). The cell tree and the 3D view share one selection: picking a row
 * highlights the mesh, clicking a mesh selects the row. The overlap list
 * stays out (the React-native `openmc-overlap-widget.tsx` is untouched).
 *
 * This widget is intentionally NOT wired into any contribution yet: the
 * parent phase registers the opener, feeds it the extractor output path,
 * and forwards tree selections from `openmc-geometry-tree.tsx`.
 */
@injectable()
export class GeometryNativeViewerWidget extends ReactWidget implements ViewerSettingsHost, CsgOutlineHost {
    static readonly ID: string = 'geometry-native-viewer-widget';
    static readonly LABEL: string = 'Native Geometry Viewer';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(ThemeService)
    protected readonly themeService!: ThemeService;

    protected modelUri: URI | undefined;
    protected cells: GeometryNativeCell[] = [];
    protected surfaceCount = 0;
    protected skippedDegenerate = 0;
    protected selectedCellId: number | null = null;
    protected hiddenMaterials: string[] = [];
    /** Per-cell hidden set (outline eye buttons); void toggle is separate. */
    protected hiddenCellIds: number[] = [];
    /** Void cells stay visible by default (they are modeled parts, unlike the DAGMC graveyard). */
    protected showVoid = true;
    protected opacity = DEFAULT_VIEWER_TOOLBAR_STATE.opacity;
    protected background = DEFAULT_VIEWER_BACKGROUND;
    protected clip: ClipPlanesState = createClipPlanesState();
    /** Active X/Y/Z tab of the side-panel clip control (per-axis settings persist). */
    protected clipTab: ClipAxis = 'X';
    protected isLoading = false;
    protected error: string | undefined;
    protected statusMessage = '';
    private loadToken = 0;

    private host: HTMLElement | undefined;
    private renderer: THREE.WebGLRenderer | undefined;
    private scene: THREE.Scene | undefined;
    private camera: THREE.PerspectiveCamera | undefined;
    private dataGroup: THREE.Group | undefined;
    private orbitControls: OrbitControlsHandle | undefined;
    private resizeObserver: ResizeObserver | undefined;
    private gizmo: ViewCubeHandle | null = null;
    private contextMenuClose: (() => void) | undefined;
    private readonly outlineChanged = new Emitter<void>();
    readonly onDidChangeCsgOutline: Event<void> = this.outlineChanged.event;

    @postConstruct()
    protected init(): void {
        this.id = GeometryNativeViewerWidget.ID;
        this.title.label = GeometryNativeViewerWidget.LABEL;
        this.title.iconClass = codicon('globe');
        this.title.closable = true;
        this.node.tabIndex = 0;
        this.toDispose.push(this.themeService.onDidColorThemeChange(() => this.onColorThemeChanged()));
        this.toDispose.push(Disposable.create(() => this.outlineChanged.dispose()));
    }

    /** Rebuild on theme switch (cell/edge colors bake at build time) and refresh the outline. */
    protected onColorThemeChanged(): void {
        if (this.isDisposed) {
            return;
        }
        if (this.cells.length > 0) {
            this.buildScene();
        }
        this.fireCsgOutlineChanged();
        this.update();
    }

    /** Dark treatment unless the active theme is explicitly light. */
    protected isDarkTheme(): boolean {
        try {
            return getThemeMode(this.themeService.getCurrentTheme().type) !== 'light';
        } catch {
            return true;
        }
    }

    /** Notify the bound outline panel to re-read the snapshot. */
    protected fireCsgOutlineChanged(): void {
        this.outlineChanged.fire(undefined);
    }

    // ------------------------------------------------------------------
    // Public props API (instant, no restart)
    // ------------------------------------------------------------------

    getProps(): GeometryNativeViewerProps {
        return {
            selectedCellId: this.selectedCellId,
            opacity: this.opacity,
            clip: {
                X: { ...this.clip.X },
                Y: { ...this.clip.Y },
                Z: { ...this.clip.Z }
            },
            hiddenMaterials: [...this.hiddenMaterials]
        };
    }

    /** Apply viewer props; selection/opacity/clip/visibility take effect immediately. */
    applyProps(props: GeometryNativeViewerProps): void {
        let structureChanged = false;
        if (props.selectedCellId !== undefined && props.selectedCellId !== this.selectedCellId) {
            this.selectedCellId = props.selectedCellId;
            this.applyHighlight();
            this.renderScene();
        }
        if (props.opacity !== undefined) {
            const opacity = clampSliderValue(props.opacity, OPACITY_SPEC);
            if (opacity !== this.opacity) {
                this.opacity = opacity;
                this.syncMaterialProps();
                this.renderScene();
            }
        }
        if (props.clip !== undefined) {
            this.clip = props.clip;
            this.applyClip();
            this.renderScene();
        }
        if (props.hiddenMaterials !== undefined) {
            this.hiddenMaterials = [...props.hiddenMaterials];
            structureChanged = true;
        }
        if (structureChanged) {
            this.buildScene();
        }
        this.update();
    }

    // ------------------------------------------------------------------
    // Viewer Settings sidebar API (single-direction sync: the panel reads
    // the snapshot and applies edits through these setters — the same calls
    // the side panel makes, never duplicated state). Geometry has no
    // color-by/shading/measure sections, so the snapshot carries only clip,
    // opacity, background, and the snap handle.
    // ------------------------------------------------------------------

    /** Snap the camera to an orbit-handle direction (sidebar snap group). */
    snapViewerTo(direction: BoundsCorner): void {
        this.orbitControls?.setViewDirection(direction);
    }

    /** Read the current settings for the sidebar panel. */
    getViewerSettingsSnapshot(): ViewerSettingsSnapshot {
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: this.cells.length > 0,
            clip: { state: this.clip, tab: this.clipTab },
            opacity: { value: this.opacity, min: OPACITY_SPEC.min, max: OPACITY_SPEC.max, step: OPACITY_SPEC.step },
            background: { value: this.background }
        };
    }

    /** Apply a sidebar edit through the existing prop setters. */
    applyViewerSettings(patch: ViewerSettingsPatch): void {
        if (patch.clipTab !== undefined && patch.clipTab !== this.clipTab) {
            this.clipTab = patch.clipTab;
            this.update();
        }
        if (patch.snap !== undefined) {
            this.snapViewerTo(viewerSnapDirection(patch.snap));
        }
        if (patch.background !== undefined && patch.background !== this.background) {
            this.background = patch.background;
            this.applyBackground();
        }
        this.applyProps({ opacity: patch.opacity, clip: patch.clip });
    }

    /** Apply the background state to the live scene (no-op until the renderer exists). */
    private applyBackground(): void {
        if (this.scene) {
            this.scene.background = new THREE.Color(this.background);
        }
        this.renderScene();
    }

    /** Tree-side selection entry point: highlight the mesh for a cell id. */
    selectCell(id: number | null): void {
        this.applyProps({ selectedCellId: id });
        this.fireCsgOutlineChanged();
    }

    /** Read the current outline for the CSG Outline panel. */
    getCsgOutlineSnapshot(): CsgOutlineSnapshot | undefined {
        const materials = materialNamesInOrder(this.cells).map((name) => ({
            name,
            cellCount: this.cells.filter((cell) => cell.material === name).length,
            // The void switch is an extra override on top of the material
            // hidden-set (DAGMC graveyard parity): while it is off, the
            // void material reads hidden even though it is not in the set.
            visible: isGeometryMaterialVisible(name, this.hiddenMaterials, this.showVoid)
        }));
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: this.cells.length > 0,
            cells: this.cells.map((cell) => ({
                id: cell.id,
                label: cellDisplayName(cell),
                material: cell.material,
                visible: isGeometryCellVisible(cell, this.hiddenMaterials, this.hiddenCellIds, this.showVoid),
                selected: this.selectedCellId === cell.id
            })),
            materials,
            showVoid: this.showVoid,
            visibleCount: this.visibleCells().length,
            totalCount: this.cells.length,
            selectedCellId: this.selectedCellId
        };
    }

    /** Apply an outline edit through the existing visibility setters. */
    applyCsgOutline(patch: CsgOutlinePatch): void {
        if (patch.toggleCell !== undefined) {
            this.toggleCell(patch.toggleCell);
        }
        if (patch.toggleMaterial !== undefined) {
            this.toggleMaterial(patch.toggleMaterial);
        }
        if (patch.showVoid !== undefined && patch.showVoid !== this.showVoid) {
            this.showVoid = patch.showVoid;
            this.buildScene();
            this.fireCsgOutlineChanged();
            this.update();
        }
        if (patch.showAll === true) {
            this.showAllCells();
        }
        if (patch.selectCell !== undefined) {
            this.selectCell(patch.selectCell);
        }
    }

    /** Store a validated extractor payload (unknown fields ignored). */
    setModelJson(value: unknown): void {
        const model = parseGeometryNativeModel(value);
        this.cells = model.cells;
        this.surfaceCount = model.surfaces.length;
        this.selectedCellId = null;
        this.hiddenCellIds = [];
        this.isLoading = false;
        this.error = undefined;
        this.buildScene();
        this.fireCsgOutlineChanged();
        this.update();
    }

    /**
     * Instant-open entry: show the viewer tab with a loading spinner while
     * `openmc.geometry-mesh` extracts, so the tab appears immediately
     * instead of waiting on the conversion (DAGMC `beginPendingLoad`
     * parity). The later `setModelFile` replaces the title/caption.
     */
    beginPendingLoad(label: string, statusMessage: string): void {
        this.modelUri = undefined;
        this.cells = [];
        this.surfaceCount = 0;
        this.skippedDegenerate = 0;
        this.selectedCellId = null;
        this.hiddenCellIds = [];
        this.hiddenMaterials = [];
        this.showVoid = true;
        this.title.label = `${GeometryNativeViewerWidget.LABEL}: ${label}`;
        this.title.caption = `${GeometryNativeViewerWidget.LABEL}: ${label}`;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = statusMessage;
        this.fireCsgOutlineChanged();
        this.update();
    }

    /** Fail the pending load in-tab (extraction failure shows the error panel, not a toast-only dead end). */
    failPendingLoad(message: string): void {
        this.isLoading = false;
        this.error = message;
        this.fireCsgOutlineChanged();
        this.update();
    }

    /** Load a P3-D1 extractor JSON file through Theia's FileService (no HTTP fetch). */
    async setModelFile(uri: URI): Promise<void> {
        this.modelUri = uri;
        this.id = `${GeometryNativeViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${GeometryNativeViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${GeometryNativeViewerWidget.LABEL}: ${uri.path.toString()}`;
        const token = ++this.loadToken;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Reading geometry model…';
        this.update();
        try {
            const text = await readVtkText(this.fileService, uri);
            if (token !== this.loadToken) {
                return;
            }
            this.setModelJson(parseGeometryNativeJson(text));
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to load geometry model: ${this.error}`);
            this.update();
        }
    }

    /** Download a screenshot of the current canvas (one-click PNG by default). */
    saveScreenshot(options: ScreenshotOptions = {}): void {
        if (!this.renderer || !this.scene || !this.camera || this.cells.length === 0) {
            return;
        }
        const dataUrl = captureRendererScreenshot(this.renderer, this.scene, this.camera, this.host ?? this.renderer.domElement, options);
        this.renderScene();
        downloadScreenshotDataUrl(dataUrl, {
            ...options,
            filename: buildScreenshotFilename(this.modelUri?.path.base ?? 'geometry', new Date(), options.format ?? 'png')
        });
    }

    /** Copy the current canvas to the clipboard (falls back to a visible warning). */
    async copyScreenshot(options: ScreenshotOptions = {}): Promise<void> {
        if (!this.renderer || !this.scene || !this.camera) {
            return;
        }
        const dataUrl = captureRendererScreenshot(this.renderer, this.scene, this.camera, this.host ?? this.renderer.domElement, options);
        this.renderScene();
        try {
            await copyScreenshotDataUrl(dataUrl);
        } catch (error) {
            this.messageService.warn(error instanceof Error ? error.message : String(error));
        }
    }

    /** Frame all visible cells through the orbit controls (target + distance). */
    fitView(): void {
        const bounds = geometryBounds(this.visibleCells());
        if (!bounds || !this.camera || !this.orbitControls) {
            return;
        }
        this.orbitControls.fitBounds(bounds.min, bounds.max);
    }

    // ------------------------------------------------------------------
    // Visibility helpers
    // ------------------------------------------------------------------

    protected visibleCells(): GeometryNativeCell[] {
        return this.cells.filter((cell) => isGeometryCellVisible(cell, this.hiddenMaterials, this.hiddenCellIds, this.showVoid));
    }

    protected toggleMaterial(material: string): void {
        this.hiddenMaterials = this.hiddenMaterials.includes(material)
            ? this.hiddenMaterials.filter((entry) => entry !== material)
            : [...this.hiddenMaterials, material];
        this.buildScene();
        this.fireCsgOutlineChanged();
        this.update();
    }

    /** Toggle one cell row (outline eye button). */
    protected toggleCell(id: number): void {
        this.hiddenCellIds = this.hiddenCellIds.includes(id)
            ? this.hiddenCellIds.filter((entry) => entry !== id)
            : [...this.hiddenCellIds, id];
        this.buildScene();
        this.fireCsgOutlineChanged();
        this.update();
    }

    /** Show everything (hidden cells + materials); the void switch is kept, mirroring the DAGMC graveyard rule. */
    protected showAllCells(): void {
        this.hiddenCellIds = [];
        this.hiddenMaterials = [];
        this.buildScene();
        this.fireCsgOutlineChanged();
        this.update();
    }

    /** Isolate one cell: show everything, then hide every other visible cell. */
    protected isolateCell(id: number): void {
        const entry = this.cells.find((cell) => cell.id === id);
        this.hiddenCellIds = [];
        this.hiddenMaterials = [];
        if (entry && isVoidMaterial(entry.material) && !this.showVoid) {
            this.showVoid = true;
        }
        const visible = new Set(this.visibleCells().map((cell) => cell.id));
        visible.delete(id);
        this.hiddenCellIds = [...visible];
        this.buildScene();
        this.fireCsgOutlineChanged();
        this.update();
    }

    // ------------------------------------------------------------------
    // React rendering
    // ------------------------------------------------------------------

    protected render(): React.ReactNode {
        return <div className="openmc-output-viewer-container">{this.error ? this.renderError() : this.renderContent()}</div>;
    }

    protected renderContent(): React.ReactNode {
        if (this.isLoading && this.cells.length === 0) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-spinner"></div>
                    <span>{this.statusMessage || 'Loading…'}</span>
                </div>
            );
        }
        const disabled = this.isLoading || this.cells.length === 0;
        return (
            <div className="openmc-output-viewer-viewarea">
                <div className="openmc-output-viewer-hint nuke-viewer-status-line">
                    {this.describeModel()} Drag to orbit, wheel to zoom, right-drag to pan, click a box to select.
                </div>
                <div style={{ flex: '1', minHeight: '0', position: 'relative', display: 'flex' }}>
                    <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                    {this.cells.length > 0 && <ViewBadge text={this.modelUri?.path.base ?? 'CSG cells'} />}
                    <ViewerNavBar disabled={disabled} onAction={(action) => this.handleNavAction(action)}>
                        <ViewerFileActions
                            disabled={disabled}
                            onScreenshot={() => this.saveScreenshot()}
                            onReload={() => this.modelUri && this.setModelFile(this.modelUri)}
                            exportMenu={
                                <ViewerExportMenu
                                    disabled={disabled}
                                    onExport={(options) => this.saveScreenshot(options)}
                                    onCopy={(options) => void this.copyScreenshot(options)}
                                />
                            }
                        />
                    </ViewerNavBar>
                    {this.cells.length > 0 && (
                        <ViewCube
                            ref={(handle) => {
                                this.gizmo = handle;
                            }}
                            onSnap={(direction) => this.orbitControls?.setViewDirection(direction)}
                        />
                    )}
                </div>
            </div>
        );
    }

    /** Route bottom-bar actions onto the orbit handle (fit/zoom/views). */
    private handleNavAction(action: ViewerNavAction): void {
        if (action === 'fit') {
            this.fitView();
            return;
        }
        if (action === 'zoom-in') {
            this.orbitControls?.zoomBy(0.8);
            return;
        }
        if (action === 'zoom-out') {
            this.orbitControls?.zoomBy(1.25);
            return;
        }
        this.orbitControls?.setViewDirection(standardViewDirection(action));
    }

    /** Re-project the cube axes for the current camera (direct DOM writes, never React state). */
    private updateGizmo(): void {
        const gizmo = this.gizmo;
        const camera = this.camera;
        if (!gizmo || !camera || this.cells.length === 0) {
            return;
        }
        const quaternion = camera.quaternion;
        gizmo.update({ quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
    }

    protected renderError(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-status error">
                <i className={codicon('error')}></i>
                <span>{this.error}</span>
                {this.modelUri && (
                    <button className="theia-button secondary" onClick={() => this.modelUri && this.setModelFile(this.modelUri)}>
                        <i className={codicon('refresh')}></i>
                        Retry
                    </button>
                )}
            </div>
        );
    }

    private describeModel(): string {
        if (this.cells.length === 0) {
            return this.isLoading ? this.statusMessage : 'No cells loaded';
        }
        const visible = this.visibleCells().length;
        const selected = this.selectedCellId !== null ? ` — Cell ${this.selectedCellId} highlighted` : '';
        return `CSG boxes — ${visible} of ${this.cells.length} cells${selected}`;
    }

    // ------------------------------------------------------------------
    // three.js scene (rebuilt on structure change; highlight recolors only)
    // ------------------------------------------------------------------

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.ensureRenderer();
    }

    protected onBeforeDetach(msg: Message): void {
        this.teardownRenderer();
        super.onBeforeDetach(msg);
    }

    override dispose(): void {
        this.loadToken++;
        this.teardownRenderer();
        super.dispose();
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.resizeRenderer();
    }

    private attachHost = (element: HTMLElement | null): void => {
        this.host = element ?? undefined;
        this.ensureRenderer();
    };

    private ensureRenderer(): void {
        if (this.renderer || !this.host || !this.isAttached) {
            return;
        }
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        this.renderer.localClippingEnabled = true;
        this.host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.background);
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(1, 2, 3);
        this.scene.add(directional);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.attachOrbitControls();
        this.attachPickHandlers(this.renderer.domElement);
        this.attachContextMenu(this.renderer.domElement);
        this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
        if (this.host) {
            this.resizeObserver.observe(this.host);
        }
        this.resizeRenderer();
        if (this.cells.length > 0) {
            this.buildScene();
        } else {
            this.renderScene();
        }
    }

    private teardownRenderer(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        this.orbitControls?.dispose();
        this.orbitControls = undefined;
        this.contextMenuClose?.();
        this.contextMenuClose = undefined;
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.domElement.remove();
            this.renderer = undefined;
        }
        this.scene = undefined;
        this.camera = undefined;
        this.dataGroup = undefined;
    }

    private resizeRenderer(): void {
        if (!this.renderer || !this.camera || !this.host) {
            return;
        }
        const width = Math.max(1, this.host.clientWidth);
        const height = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderScene();
    }

    private renderScene(): void {
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
        this.updateGizmo();
    }

    private disposeGroup(group: THREE.Group): void {
        group.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                child.geometry.dispose();
                const material = child.material as THREE.Material;
                material.dispose();
            }
        });
    }

    /** Rebuild the data group from the visible cells (new model or toggle change). */
    private buildScene(): void {
        if (!this.scene || !this.camera) {
            return;
        }
        if (this.dataGroup) {
            this.scene.remove(this.dataGroup);
            this.disposeGroup(this.dataGroup);
            this.dataGroup = undefined;
        }
        this.dataGroup = new THREE.Group();
        this.skippedDegenerate = 0;
        for (const cell of this.cells) {
            if (!isGeometryCellVisible(cell, this.hiddenMaterials, this.hiddenCellIds, this.showVoid)) {
                if (isDegenerateCell(cell)) {
                    this.skippedDegenerate++;
                }
                continue;
            }
            this.dataGroup.add(this.buildCellMesh(cell));
        }
        this.scene.add(this.dataGroup);
        this.fitView();
        this.applyHighlight();
        this.applyClip();
        this.syncMaterialProps();
        this.renderScene();
    }

    private buildCellMesh(cell: GeometryNativeCell): THREE.Group {
        const group = new THREE.Group();
        group.name = meshNameForCell(cell.id);
        const minX = Math.min(cell.bbox.min[0], cell.bbox.max[0]);
        const minY = Math.min(cell.bbox.min[1], cell.bbox.max[1]);
        const minZ = Math.min(cell.bbox.min[2], cell.bbox.max[2]);
        const maxX = Math.max(cell.bbox.min[0], cell.bbox.max[0]);
        const maxY = Math.max(cell.bbox.min[1], cell.bbox.max[1]);
        const maxZ = Math.max(cell.bbox.min[2], cell.bbox.max[2]);
        const geometry = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
        const color = new THREE.Color(colorForCellOnTheme(cell, this.isDarkTheme()));
        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshLambertMaterial({ color, transparent: true, opacity: this.opacity, side: THREE.DoubleSide })
        );
        mesh.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        mesh.name = meshNameForCell(cell.id);
        mesh.userData = { cellId: cell.id, baseColor: `#${color.getHexString()}` };
        group.add(mesh);
        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: cellEdgeColor(this.isDarkTheme()), transparent: true, opacity: 0.6 })
        );
        edges.position.copy(mesh.position);
        edges.name = `${meshNameForCell(cell.id)}:edges`;
        group.add(edges);
        return group;
    }

    /**
     * Tree↔3D highlight sync: recolor only. The selected cell keeps its base
     * color but glows (emissive); every other mesh returns to its base color.
     */
    private applyHighlight(): void {
        if (!this.dataGroup) {
            return;
        }
        this.dataGroup.children.forEach((group) => {
            const id = cellIdFromMeshName(group.name);
            group.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    const material = child.material as THREE.MeshLambertMaterial;
                    const base = new THREE.Color((child.userData['baseColor'] as string) ?? '#d4d4d4');
                    material.color.copy(base);
                    material.emissive = new THREE.Color(id !== undefined && id === this.selectedCellId ? 0x664400 : 0x000000);
                }
            });
        });
    }

    /** Apply the viewer-core per-axis clip state to every cell material. */
    private applyClip(): void {
        if (!this.dataGroup) {
            return;
        }
        const bounds = geometryBounds(this.visibleCells());
        const planes = bounds
            ? toThreePlaneParamsArray(this.clip, bounds).map(
                  (params) => new THREE.Plane(new THREE.Vector3(...params.normal), params.constant)
              )
            : [];
        this.dataGroup.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                (child.material as THREE.Material).clippingPlanes = planes;
            }
        });
    }

    private syncMaterialProps(): void {
        this.dataGroup?.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                (child.material as THREE.MeshLambertMaterial).opacity = this.opacity;
            }
        });
    }

    // ------------------------------------------------------------------
    // Picking (3D→tree); orbit navigation lives in the shared viewer-core
    // helper (OrbitControls; gestures render on demand through `renderScene`)
    // ------------------------------------------------------------------

    /** Click (not drag) raycasts meshes and selects the cell — the 3D→tree half of sync. */
    private pickCell(clientX: number, clientY: number): void {
        if (!this.renderer || !this.camera || !this.dataGroup) {
            return;
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        const pointer = new THREE.Vector2(
            ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
            -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(pointer, this.camera);
        const hits = raycaster.intersectObjects(this.dataGroup.children, true);
        for (const hit of hits) {
            let node: THREE.Object3D | null = hit.object;
            while (node) {
                const id = cellIdFromMeshName(node.name);
                if (id !== undefined) {
                    this.selectCell(id === this.selectedCellId ? null : id);
                    return;
                }
                node = node.parent;
            }
        }
    }

    /**
     * Click (not drag) raycasts meshes and selects the cell — the 3D→tree
     * half of sync. OrbitControls owns drag gestures on the same canvas, so
     * a pointerup within 4px of its pointerdown counts as a click.
     */
    private attachPickHandlers(canvas: HTMLCanvasElement): void {
        let downX = 0;
        let downY = 0;
        canvas.addEventListener('pointerdown', (e) => {
            downX = e.clientX;
            downY = e.clientY;
        });
        canvas.addEventListener('pointerup', (e) => {
            if (e.button === 0 && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) <= 4) {
                this.pickCell(e.clientX, e.clientY);
            }
        });
    }

    /**
     * Right-click view menu (DAGMC/native-VTK parity): Fit, Screenshot,
     * clip toggle, plus Hide / Isolate for the selected cell and Show all.
     * The native browser menu is already suppressed by the shared
     * orbit-controls helper; a right-drag pan never opens the menu.
     */
    private attachContextMenu(canvas: HTMLCanvasElement): void {
        let downX = 0;
        let downY = 0;
        let downButton = -1;
        canvas.addEventListener('pointerdown', (event) => {
            if (event.button === 2) {
                downX = event.clientX;
                downY = event.clientY;
                downButton = 2;
            }
        });
        canvas.addEventListener('pointerup', (event) => {
            if (event.button === 2 && downButton === 2) {
                downButton = -1;
                if (isViewerContextMenuClick(downX, downY, event.clientX, event.clientY)) {
                    this.openContextMenu(event.clientX, event.clientY);
                }
            }
        });
    }

    /** Open the canvas menu for the current selection (no-op before a model loads). */
    private openContextMenu(clientX: number, clientY: number): void {
        if (this.cells.length === 0) {
            return;
        }
        this.contextMenuClose?.();
        this.contextMenuClose = openViewerContextMenu(
            { x: clientX, y: clientY },
            buildGeometryContextMenuItems({
                clipChecked: anyClipEnabled(this.clip),
                selectedCellId: this.selectedCellId,
                hasHidden: this.hiddenCellIds.length > 0 || this.hiddenMaterials.length > 0
            }),
            (id) => this.handleContextMenuAction(id)
        );
    }

    /** Route a canvas-menu pick onto the existing setters (same calls the outline panel makes). */
    private handleContextMenuAction(id: string): void {
        if (id === 'fit') {
            this.fitView();
        } else if (id === 'screenshot') {
            this.saveScreenshot();
        } else if (id === 'clip') {
            this.applyProps({ clip: setAllClipEnabled(this.clip, !anyClipEnabled(this.clip)) });
        } else if (id === 'hide-selected') {
            if (this.selectedCellId !== null) {
                this.applyCsgOutline({ toggleCell: this.selectedCellId });
            }
        } else if (id === 'isolate-selected') {
            if (this.selectedCellId !== null) {
                this.isolateCell(this.selectedCellId);
                this.fireCsgOutlineChanged();
                this.update();
            }
        } else if (id === 'show-all') {
            this.applyCsgOutline({ showAll: true });
        }
        this.update();
    }

    /**
     * Attach OrbitControls to the renderer canvas. The controls class loads
     * asynchronously (same dynamic import style as nuke-cad); a renderer
     * teardown before the import resolves disposes the stale handle. Once
     * attached, the visible cells are framed through the controls.
     */
    private attachOrbitControls(): void {
        const renderer = this.renderer;
        const camera = this.camera;
        if (!renderer || !camera) {
            return;
        }
        createOrbitControls(camera, renderer.domElement, { onChange: () => this.renderScene() })
            .then((handle) => {
                if (this.renderer !== renderer) {
                    handle.dispose();
                    return;
                }
                this.orbitControls?.dispose();
                this.orbitControls = handle;
                this.fitView();
            })
            .catch((error) => {
                console.warn('[GeometryNativeViewer] Failed to load orbit controls:', error);
            });
    }
}
