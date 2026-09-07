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
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    ClipPlaneState,
    clipOriginAtFraction,
    clipProjectionExtent,
    createClipPlaneState,
    fitClipOriginToBounds,
    toThreePlaneParams
} from '../../../../viewer-core/clip-plane';
import { clampSliderValue, DEFAULT_VIEWER_TOOLBAR_STATE, OPACITY_SPEC } from '../../../../viewer-core/viewer-toolbar-model';
import {
    cellDisplayName,
    cellIdFromMeshName,
    colorForCell,
    filterGeometryCells,
    geometryBounds,
    GeometryNativeCell,
    isDegenerateCell,
    materialNamesInOrder,
    meshNameForCell,
    parseGeometryNativeJson,
    parseGeometryNativeModel
} from './geometry-native-model';
import { readVtkText } from '../native-vtk/native-vtk-data';
import '../output-viewer.css';

/**
 * Props driving the native geometry viewer. Every field applies instantly to
 * the already-loaded cells — selecting, hiding materials, changing opacity,
 * or moving the clip plane never restarts anything (there is no trame
 * server; this is the P3-D2 replacement for the `geometry_viz.py` CSG
 * multiblock server and the `openmc-geometry-3d-widget.tsx` iframe).
 */
export interface GeometryNativeViewerProps {
    /** Highlighted cell id (tree↔3D sync key); null clears the highlight. */
    selectedCellId?: number | null;
    /** Material opacity in [0, 1]. */
    opacity?: number;
    /** Clip state; applied only when `clipEnabled` is true. */
    clip?: ClipPlaneState;
    /** Whether the clip plane is active. */
    clipEnabled?: boolean;
    /** Materials hidden in the 3D view (tree still lists them). */
    hiddenMaterials?: string[];
}

/** Orbit state for the viewer's minimal built-in navigation. */
interface GeometryNativeOrbit {
    theta: number;
    phi: number;
    distance: number;
    target: THREE.Vector3;
}

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
export class GeometryNativeViewerWidget extends ReactWidget {
    static readonly ID: string = 'geometry-native-viewer-widget';
    static readonly LABEL: string = 'Native Geometry Viewer';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected modelUri: URI | undefined;
    protected cells: GeometryNativeCell[] = [];
    protected surfaceCount = 0;
    protected skippedDegenerate = 0;
    protected selectedCellId: number | null = null;
    protected filterText = '';
    protected hiddenMaterials: string[] = [];
    protected opacity = DEFAULT_VIEWER_TOOLBAR_STATE.opacity;
    protected clip: ClipPlaneState = createClipPlaneState();
    protected clipEnabled = false;
    protected isLoading = false;
    protected error: string | undefined;
    protected statusMessage = '';
    private loadToken = 0;

    private host: HTMLElement | undefined;
    private renderer: THREE.WebGLRenderer | undefined;
    private scene: THREE.Scene | undefined;
    private camera: THREE.PerspectiveCamera | undefined;
    private dataGroup: THREE.Group | undefined;
    private orbit: GeometryNativeOrbit | undefined;
    private resizeObserver: ResizeObserver | undefined;

    @postConstruct()
    protected init(): void {
        this.id = GeometryNativeViewerWidget.ID;
        this.title.label = GeometryNativeViewerWidget.LABEL;
        this.title.iconClass = codicon('globe');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    // ------------------------------------------------------------------
    // Public props API (instant, no restart)
    // ------------------------------------------------------------------

    getProps(): GeometryNativeViewerProps {
        return {
            selectedCellId: this.selectedCellId,
            opacity: this.opacity,
            clip: { ...this.clip, normal: [...this.clip.normal], origin: [...this.clip.origin] },
            clipEnabled: this.clipEnabled,
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
        if (props.clipEnabled !== undefined && props.clipEnabled !== this.clipEnabled) {
            this.clipEnabled = props.clipEnabled;
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

    /** Tree-side selection entry point: highlight the mesh for a cell id. */
    selectCell(id: number | null): void {
        this.applyProps({ selectedCellId: id });
    }

    /** Store a validated extractor payload (unknown fields ignored). */
    setModelJson(value: unknown): void {
        const model = parseGeometryNativeModel(value);
        this.cells = model.cells;
        this.surfaceCount = model.surfaces.length;
        this.selectedCellId = null;
        this.isLoading = false;
        this.error = undefined;
        const bounds = geometryBounds(this.cells);
        if (bounds) {
            this.clip = fitClipOriginToBounds(this.clip, bounds);
        }
        this.buildScene();
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

    /** Download a PNG screenshot of the current canvas. */
    saveScreenshot(): void {
        if (!this.renderer || this.cells.length === 0) {
            return;
        }
        this.renderScene();
        const url = this.renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.modelUri?.path.base ?? 'geometry'}.png`;
        link.click();
    }

    /** Frame all visible cells. */
    fitView(): void {
        const bounds = geometryBounds(this.visibleCells());
        if (!bounds || !this.camera || !this.orbit) {
            return;
        }
        const box = new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max));
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        this.orbit.target.copy(sphere.center);
        this.orbit.distance = Math.max(sphere.radius * 2.2, 1e-6);
        this.applyOrbit();
    }

    // ------------------------------------------------------------------
    // Visibility helpers
    // ------------------------------------------------------------------

    protected visibleCells(): GeometryNativeCell[] {
        return this.cells.filter((cell) => !this.hiddenMaterials.includes(cell.material) && !isDegenerateCell(cell));
    }

    protected toggleMaterial(material: string): void {
        this.hiddenMaterials = this.hiddenMaterials.includes(material)
            ? this.hiddenMaterials.filter((entry) => entry !== material)
            : [...this.hiddenMaterials, material];
        this.buildScene();
        this.update();
    }

    // ------------------------------------------------------------------
    // React rendering
    // ------------------------------------------------------------------

    protected render(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-container">
                {this.renderHeader()}
                {this.error ? this.renderError() : this.renderContent()}
            </div>
        );
    }

    protected renderHeader(): React.ReactNode {
        const fileName = this.modelUri?.path.base ?? 'No model loaded';
        return (
            <div className="openmc-output-viewer-header">
                <span className="openmc-output-viewer-file">
                    <i className={codicon('globe')}></i>
                    {fileName}
                </span>
                <button
                    className="theia-button secondary"
                    onClick={() => this.fitView()}
                    disabled={this.isLoading || this.cells.length === 0}
                    title="Fit view to visible cells"
                >
                    <i className={codicon('screen-full')}></i>
                </button>
                <button
                    className="theia-button secondary"
                    onClick={() => this.saveScreenshot()}
                    disabled={this.isLoading || this.cells.length === 0}
                    title="Download PNG screenshot"
                >
                    <i className={codicon('device-camera')}></i>
                </button>
                <button
                    className="theia-button secondary"
                    onClick={() => this.modelUri && this.setModelFile(this.modelUri)}
                    disabled={this.isLoading || !this.modelUri}
                    title="Reload model file"
                >
                    <i className={codicon('refresh')}></i>
                </button>
            </div>
        );
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
        const filtered = filterGeometryCells(this.cells, this.filterText);
        return (
            <>
                <div className="openmc-output-viewer-viewarea" style={{ flexDirection: 'row' }}>
                    <div
                        style={{ width: '240px', minWidth: '180px', overflow: 'auto', borderRight: '1px solid var(--theia-panel-border)' }}
                    >
                        <div style={{ padding: '4px 8px' }}>
                            <input
                                type="text"
                                placeholder="Filter cells, materials…"
                                value={this.filterText}
                                onChange={(e) => {
                                    this.filterText = e.target.value;
                                    this.update();
                                }}
                                style={{ width: '100%' }}
                            />
                        </div>
                        {filtered.map((cell) => (
                            <div
                                key={cell.id}
                                onClick={() => this.selectCell(cell.id === this.selectedCellId ? null : cell.id)}
                                title={`${cellDisplayName(cell)} — ${cell.material}`}
                                style={{
                                    padding: '2px 8px',
                                    fontSize: '12px',
                                    cursor: 'pointer',
                                    background: cell.id === this.selectedCellId ? 'var(--theia-list-activeSelectionBackground)' : undefined,
                                    color: cell.id === this.selectedCellId ? 'var(--theia-list-activeSelectionForeground)' : undefined,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px'
                                }}
                            >
                                <span
                                    style={{
                                        width: '10px',
                                        height: '10px',
                                        flexShrink: 0,
                                        background: colorForCell(cell),
                                        border: '1px solid var(--theia-panel-border)'
                                    }}
                                />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {cellDisplayName(cell)}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div style={{ flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column' }}>
                        <div className="openmc-output-viewer-hint">
                            {this.describeModel()} Drag to orbit, wheel to zoom, right-drag to pan, click a box to select.
                        </div>
                        <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                    </div>
                </div>
                {this.renderSidePanel()}
            </>
        );
    }

    protected renderSidePanel(): React.ReactNode {
        if (this.cells.length === 0) {
            return undefined;
        }
        const materials = materialNamesInOrder(this.cells);
        const visible = this.visibleCells().length;
        const bounds = geometryBounds(this.visibleCells());
        const extent = bounds ? clipProjectionExtent(bounds, this.clip.normal) : { min: 0, max: 0 };
        const span = extent.max - extent.min;
        const dot =
            this.clip.normal[0] * this.clip.origin[0] +
            this.clip.normal[1] * this.clip.origin[1] +
            this.clip.normal[2] * this.clip.origin[2];
        const fraction = span > 0 ? (dot - extent.min) / span : 0.5;
        return (
            <div style={{ display: 'flex', gap: '16px', padding: '4px 8px', flexWrap: 'wrap', fontSize: '11px', alignItems: 'center' }}>
                <span title="Visible cells">
                    {visible} of {this.cells.length} cells{this.surfaceCount > 0 ? `, ${this.surfaceCount} surfaces` : ''}
                    {this.skippedDegenerate > 0 ? ` (${this.skippedDegenerate} degenerate hidden)` : ''}
                </span>
                <label title="Material opacity">
                    Opacity
                    <input
                        type="range"
                        min={OPACITY_SPEC.min}
                        max={OPACITY_SPEC.max}
                        step={OPACITY_SPEC.step}
                        value={this.opacity}
                        onChange={(e) => this.applyProps({ opacity: parseFloat(e.target.value) })}
                    />
                </label>
                <label title="Cell visibility by material">
                    Materials
                    <select
                        value=""
                        onChange={(e) => {
                            if (e.target.value !== '') {
                                this.toggleMaterial(e.target.value);
                            }
                        }}
                    >
                        <option value="">Toggle material…</option>
                        {materials.map((material) => (
                            <option key={material} value={material}>
                                {`${this.hiddenMaterials.includes(material) ? '○' : '●'} ${material}`}
                            </option>
                        ))}
                    </select>
                </label>
                <label
                    style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                    title="Arbitrary-normal clip plane (viewer-core clip state)"
                >
                    <input
                        type="checkbox"
                        checked={this.clipEnabled}
                        onChange={(e) => this.applyProps({ clipEnabled: e.target.checked })}
                    />
                    Clip
                </label>
                <button
                    className="theia-button secondary"
                    title="Flip kept half-space"
                    disabled={!this.clipEnabled}
                    onClick={() => this.applyProps({ clip: { ...this.clip, invert: !this.clip.invert } })}
                >
                    {this.clip.invert ? 'Unflip' : 'Flip'}
                </button>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={Math.min(1, Math.max(0, fraction))}
                    disabled={!this.clipEnabled || !bounds}
                    title="Sweep the plane origin across the dataset"
                    onChange={(e) =>
                        this.applyProps({
                            clip: { ...this.clip, origin: clipOriginAtFraction(this.clip.normal, bounds!, parseFloat(e.target.value)) }
                        })
                    }
                />
            </div>
        );
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
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(1, 2, 3);
        this.scene.add(directional);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.orbit = { theta: Math.PI / 4, phi: Math.PI / 3, distance: 10, target: new THREE.Vector3() };
        this.attachOrbitHandlers(this.renderer.domElement);
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
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.domElement.remove();
            this.renderer = undefined;
        }
        this.scene = undefined;
        this.camera = undefined;
        this.dataGroup = undefined;
        this.orbit = undefined;
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
        if (!this.scene || !this.camera || !this.orbit) {
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
            if (this.hiddenMaterials.includes(cell.material)) {
                continue;
            }
            if (isDegenerateCell(cell)) {
                this.skippedDegenerate++;
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
        const color = new THREE.Color(colorForCell(cell));
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
            new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.6 })
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

    /** Apply the viewer-core clip state to every cell material. */
    private applyClip(): void {
        if (!this.dataGroup) {
            return;
        }
        const params = toThreePlaneParams(this.clip);
        const planes = this.clipEnabled ? [new THREE.Plane(new THREE.Vector3(...params.normal), params.constant)] : [];
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
    // Picking (3D→tree) + minimal orbit navigation (rotate / zoom / pan)
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

    private attachOrbitHandlers(canvas: HTMLCanvasElement): void {
        let dragging = false;
        let button = 0;
        let lastX = 0;
        let lastY = 0;
        let downX = 0;
        let downY = 0;
        canvas.addEventListener('pointerdown', (e) => {
            dragging = true;
            button = e.button;
            lastX = e.clientX;
            lastY = e.clientY;
            downX = e.clientX;
            downY = e.clientY;
            canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!dragging || !this.orbit) {
                return;
            }
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            if (button === 2 || button === 1 || e.shiftKey) {
                this.panBy(dx, dy);
            } else if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) {
                this.orbit.theta -= dx * 0.005;
                this.orbit.phi = Math.min(Math.PI - 0.01, Math.max(0.01, this.orbit.phi - dy * 0.005));
                this.applyOrbit();
            }
        });
        const stop = (e: PointerEvent): void => {
            if (dragging && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) <= 4 && e.button === 0) {
                this.pickCell(e.clientX, e.clientY);
            }
            dragging = false;
        };
        canvas.addEventListener('pointerup', stop);
        canvas.addEventListener('pointercancel', () => {
            dragging = false;
        });
        canvas.addEventListener(
            'wheel',
            (e) => {
                e.preventDefault();
                if (this.orbit) {
                    this.orbit.distance = Math.max(1e-6, this.orbit.distance * Math.exp(e.deltaY * 0.001));
                    this.applyOrbit();
                }
            },
            { passive: false }
        );
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    private applyOrbit(): void {
        if (!this.camera || !this.orbit) {
            return;
        }
        const { theta, phi, distance, target } = this.orbit;
        this.camera.position.set(
            target.x + distance * Math.sin(phi) * Math.cos(theta),
            target.y + distance * Math.cos(phi),
            target.z + distance * Math.sin(phi) * Math.sin(theta)
        );
        this.camera.lookAt(target);
        this.renderScene();
    }

    private panBy(dx: number, dy: number): void {
        if (!this.camera || !this.orbit) {
            return;
        }
        const scale = this.orbit.distance / Math.max(1, this.camera.aspect * 500);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        this.orbit.target.addScaledVector(right, -dx * scale);
        this.orbit.target.addScaledVector(up, dy * scale);
        this.applyOrbit();
    }
}
