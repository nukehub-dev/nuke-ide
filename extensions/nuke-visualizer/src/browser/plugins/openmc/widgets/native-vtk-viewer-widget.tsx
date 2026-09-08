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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    ClassifiedNativeVtkArrays,
    classifyNativeVtkArrays,
    colorByValue,
    DEFAULT_COLORMAP,
    defaultNativeColorBy,
    NATIVE_VTK_COLORMAPS,
    NativeVtkColormapName,
    NativeVtkDataArray,
    NativeVtkModel,
    normalizeToUnit,
    parseColorBy,
    parseNativeVtk,
    readVtkText,
    sampleNativeColormap,
    SOLID_COLOR,
    strideForBudget,
    tupleValue
} from './native-vtk/native-vtk-data';
import { createOrbitControls, standardViewDirection, type OrbitControlsHandle } from '../../../viewer-core/orbit-controls';
import { isViewerContextMenuClick, openViewerContextMenu } from '../../../viewer-core/viewer-context-menu';
import {
    anyClipEnabled,
    AxisAlignedBounds,
    boundingBoxFromPositions,
    CLIP_AXES,
    ClipAxis,
    ClipPlanesState,
    createClipPlanesState,
    setAllClipEnabled,
    toThreePlaneParamsArray,
    updateAxisClip
} from '../../../viewer-core/clip-plane';
import {
    DEFAULT_VIEWER_SHADING_MODE,
    VIEWER_SHADING_MODES,
    ViewerShadingMode,
    isViewerShadingMode,
    nextViewerShadingMode,
    resolveViewerShadingFlags
} from '../../../viewer-core/shading-mode';
import { OpenMCVtkArrayInfo } from '../../../../common/openmc-protocol';
import { ViewerNavAction, ViewerNavCluster } from './viewer-nav-cluster';
import './output-viewer.css';

/**
 * Props driving the native VTK viewer. Every field applies instantly to the
 * already-loaded dataset — changing color-by or the colormap never restarts
 * anything (there is no server to restart; this is the P1-B2 replacement for
 * the trame `--color-by` restart hack in `OpenMCOutputViewerWidget`).
 */
export interface NativeVtkViewerProps {
    /** `'Solid Color'`, `'Point: <name>'`, or `'Cell: <name>'` (base.serve format). */
    colorBy?: string;
    /** One of the six short colormaps. */
    colormap?: NativeVtkColormapName;
    /** CSS color used in Solid Color mode. */
    solidColor?: string;
    /** Point sprite size in pixels. */
    pointSize?: number;
    /** Material opacity in [0, 1]. */
    opacity?: number;
    /** Shading mode (`shaded` | `wireframe` | `points` | `xray`). */
    shading?: ViewerShadingMode;
    /** Per-axis clip state; each enabled axis plane applies (box-section view). */
    clip?: ClipPlanesState;
}

/**
 * Native VTK viewer widget (P1-B2): renders tracks `.vtp` polylines,
 * collision `.vtp` point clouds, weight-windows `.vtr` rectilinear grids, and
 * voxel `.vti` image grids directly in the IDE with three.js — no trame
 * server, no reverse proxy, no iframe. VTK bytes are read through Theia's
 * `FileService` (works for workspace files and backend-converted temp files
 * alike), parsed client-side by `native-vtk-data.ts`, and colored per-vertex
 * from the selected array, so color-by/colormap switches only rewrite a color
 * buffer. Grids render as decimated cell-center point clouds inside their
 * bounding box (full voxel-block volume rendering is a later phase).
 *
 * This widget is intentionally NOT wired into any contribution yet: the
 * parent phase replaces the `output-viewer-widget.tsx` subclasses'
 * convert→serve→iframe lifecycle with convert→FileService→native rendering.
 */
@injectable()
export class NativeVtkViewerWidget extends ReactWidget {
    static readonly ID: string = 'native-vtk-viewer-widget';
    static readonly LABEL: string = 'Native VTK Viewer';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected fileUri: URI | undefined;
    protected model: NativeVtkModel | undefined;
    protected classified: ClassifiedNativeVtkArrays | undefined;
    protected colorBy: string = SOLID_COLOR;
    protected colormap: NativeVtkColormapName = DEFAULT_COLORMAP;
    protected solidColor = '#d4d4d4';
    protected pointSize = 3;
    protected opacity = 1;
    protected shading: ViewerShadingMode = DEFAULT_VIEWER_SHADING_MODE;
    protected clip: ClipPlanesState = createClipPlanesState();
    /** Active X/Y/Z tab of the header clip control (per-axis settings persist). */
    protected clipTab: ClipAxis = 'X';
    protected isLoading = false;
    protected error: string | undefined;
    protected statusMessage = '';
    protected note = '';
    private loadToken = 0;

    private host: HTMLElement | undefined;
    private renderer: THREE.WebGLRenderer | undefined;
    private scene: THREE.Scene | undefined;
    private camera: THREE.PerspectiveCamera | undefined;
    private dataGroup: THREE.Group | undefined;
    private orbitControls: OrbitControlsHandle | undefined;
    private resizeObserver: ResizeObserver | undefined;
    private contextMenuClose: (() => void) | undefined;

    @postConstruct()
    protected init(): void {
        this.id = NativeVtkViewerWidget.ID;
        this.title.label = NativeVtkViewerWidget.LABEL;
        this.title.iconClass = codicon('layers');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    // ------------------------------------------------------------------
    // Public props API (instant, no restart)
    // ------------------------------------------------------------------

    getProps(): NativeVtkViewerProps {
        return {
            colorBy: this.colorBy,
            colormap: this.colormap,
            solidColor: this.solidColor,
            pointSize: this.pointSize,
            opacity: this.opacity,
            shading: this.shading,
            clip: {
                X: { ...this.clip.X },
                Y: { ...this.clip.Y },
                Z: { ...this.clip.Z }
            }
        };
    }

    /** Apply viewer props; color-by/colormap/size/opacity take effect immediately. */
    applyProps(props: NativeVtkViewerProps): void {
        let changed = false;
        if (props.colorBy !== undefined && props.colorBy !== this.colorBy) {
            this.colorBy = props.colorBy;
            changed = true;
        }
        if (props.colormap !== undefined && NATIVE_VTK_COLORMAPS.includes(props.colormap) && props.colormap !== this.colormap) {
            this.colormap = props.colormap;
            changed = true;
        }
        if (props.solidColor !== undefined && props.solidColor !== this.solidColor) {
            this.solidColor = props.solidColor;
            changed = true;
        }
        if (props.pointSize !== undefined && props.pointSize > 0 && props.pointSize !== this.pointSize) {
            this.pointSize = props.pointSize;
            changed = true;
        }
        if (props.opacity !== undefined && props.opacity !== this.opacity) {
            this.opacity = Math.min(1, Math.max(0, props.opacity));
            changed = true;
        }
        if (props.shading !== undefined && isViewerShadingMode(props.shading) && props.shading !== this.shading) {
            this.shading = props.shading;
            changed = true;
        }
        if (props.clip !== undefined) {
            this.clip = props.clip;
            changed = true;
        }
        if (changed) {
            this.recolor();
            this.update();
        }
    }

    /** Load a VTK file from disk through Theia's FileService (no HTTP fetch). */
    async setVtkFile(uri: URI): Promise<void> {
        this.fileUri = uri;
        this.id = `${NativeVtkViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${NativeVtkViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${NativeVtkViewerWidget.LABEL}: ${uri.path.toString()}`;
        const token = ++this.loadToken;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Reading VTK file…';
        this.update();
        try {
            const text = await readVtkText(this.fileService, uri);
            if (token !== this.loadToken) {
                return;
            }
            await this.setVtkText(text, token);
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to load VTK file: ${this.error}`);
            this.update();
        }
    }

    /** Load already-read VTK XML text (used after FileService reads and by future contributions). */
    async setVtkText(text: string, token = ++this.loadToken): Promise<void> {
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Parsing VTK dataset…';
        this.update();
        try {
            // Dispatcher (XML + legacy ASCII): the probe and this parse must
            // agree, or probed-OK legacy files fail here with an XML error.
            const model = await parseNativeVtk(text, this.fileUri?.path.ext ?? '');
            if (token !== this.loadToken) {
                return;
            }
            this.model = model;
            this.classified = classifyNativeVtkArrays([...model.pointArrays, ...model.cellArrays]);
            const fallback = defaultNativeColorBy(this.classified, model.family);
            if (parseColorBy(this.colorBy) === undefined || !this.hasArray(this.colorBy)) {
                this.colorBy = fallback ?? SOLID_COLOR;
            }
            this.note = '';
            this.isLoading = false;
            this.statusMessage = '';
            this.buildScene();
            this.update();
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to parse VTK dataset: ${this.error}`);
            this.update();
        }
    }

    /** Download a PNG screenshot of the current canvas (F12 equivalent). */
    saveScreenshot(): void {
        if (!this.renderer || !this.model) {
            return;
        }
        this.renderScene();
        const url = this.renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.fileUri?.path.base ?? 'native-vtk'}.png`;
        link.click();
    }

    /** Frame the loaded dataset through the orbit controls (target + distance). */
    fitView(): void {
        const model = this.model;
        if (!model || !this.camera || !this.orbitControls) {
            return;
        }
        const positions = model.positions;
        if (positions.length === 0) {
            return;
        }
        const box = new THREE.Box3();
        for (let i = 0; i < positions.length; i += 3) {
            box.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
        }
        this.orbitControls.fitBounds([box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]);
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
        const fileName = this.fileUri?.path.base ?? 'No file loaded';
        return (
            <div className="openmc-output-viewer-header">
                <span className="openmc-output-viewer-file">
                    <i className={codicon('file')}></i>
                    {fileName}
                </span>
                {this.renderColorBySelect()}
                {this.renderColormapSelect()}
                {this.renderShadingSelect()}
                {this.renderClipControls()}
                <Tooltip content="Download PNG screenshot" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.saveScreenshot()}
                        disabled={this.isLoading || !this.model}
                    >
                        <i className={codicon('device-camera')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Reload file" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.fileUri && this.setVtkFile(this.fileUri)}
                        disabled={this.isLoading || !this.fileUri}
                    >
                        <i className={codicon('refresh')}></i>
                    </button>
                </Tooltip>
            </div>
        );
    }

    protected renderColorBySelect(): React.ReactNode {
        if (!this.model || !this.classified) {
            return undefined;
        }
        const options: { value: string; label: string }[] = [{ value: SOLID_COLOR, label: SOLID_COLOR }];
        const push = (arrays: OpenMCVtkArrayInfo[]): void => {
            for (const array of arrays) {
                const value = colorByValue(array);
                options.push({ value, label: `${array.association === 'point' ? 'Point' : 'Cell'}: ${array.name}` });
            }
        };
        push(this.classified.energies);
        push(this.classified.fluxGroups);
        for (const group of this.classified.windowGroups) {
            if (group.lower) {
                options.push({ value: colorByValue(group.lower), label: `Cell: ${group.lower.name}` });
            }
            if (group.upper) {
                options.push({ value: colorByValue(group.upper), label: `Cell: ${group.upper.name}` });
            }
        }
        push(this.classified.scalars);
        push(this.classified.sources);
        push(this.classified.ids);
        push(this.classified.other);
        return (
            <Tooltip content="Color-by array (applies instantly, no viewer restart)" position="bottom">
                <label className="openmc-output-viewer-control">
                    Color by
                    <select value={this.colorBy} onChange={(e) => this.applyProps({ colorBy: e.target.value })} disabled={this.isLoading}>
                        {options.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
            </Tooltip>
        );
    }

    protected renderColormapSelect(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        const solid = this.colorBy === SOLID_COLOR;
        return (
            <Tooltip
                content={solid ? 'Colormap (select a data array in Color by first)' : 'Colormap (applies instantly)'}
                position="bottom"
            >
                <label className="openmc-output-viewer-control">
                    Map
                    <select
                        value={this.colormap}
                        onChange={(e) => this.applyProps({ colormap: e.target.value as NativeVtkColormapName })}
                        disabled={this.isLoading || solid}
                    >
                        {NATIVE_VTK_COLORMAPS.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
            </Tooltip>
        );
    }

    protected renderShadingSelect(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        return (
            <Tooltip content="Shading mode (applies instantly)" position="bottom">
                <label className="openmc-output-viewer-control">
                    Shading
                    <select
                        value={this.shading}
                        onChange={(e) => this.applyProps({ shading: e.target.value as ViewerShadingMode })}
                        disabled={this.isLoading}
                    >
                        {VIEWER_SHADING_MODES.map((mode) => (
                            <option key={mode.id} value={mode.id}>
                                {mode.label}
                            </option>
                        ))}
                    </select>
                </label>
            </Tooltip>
        );
    }

    protected renderClipControls(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        const bounds: AxisAlignedBounds | undefined = boundingBoxFromPositions(this.model.positions);
        const tab = this.clip[this.clipTab];
        return (
            <span className="openmc-output-viewer-control">
                <Tooltip content="Clip planes: master toggle (enabled planes apply together)" position="bottom">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input
                            type="checkbox"
                            checked={anyClipEnabled(this.clip)}
                            onChange={(e) => this.applyProps({ clip: setAllClipEnabled(this.clip, e.target.checked) })}
                            disabled={this.isLoading}
                        />
                        Clip
                    </label>
                </Tooltip>
                {CLIP_AXES.map((axis) => (
                    <Tooltip key={axis} content={`Clip ${axis} plane settings`} position="bottom">
                        <button
                            className={`theia-button${this.clipTab === axis ? '' : ' secondary'}`}
                            disabled={this.isLoading}
                            onClick={() => {
                                this.clipTab = axis;
                                this.update();
                            }}
                        >
                            {axis}
                        </button>
                    </Tooltip>
                ))}
                <Tooltip content={`Clip ${this.clipTab} position (percent across the dataset; enables the plane)`} position="bottom">
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(tab.fraction * 100)}
                        disabled={this.isLoading || !bounds}
                        onChange={(e) =>
                            this.applyProps({
                                clip: updateAxisClip(this.clip, this.clipTab, {
                                    enabled: true,
                                    fraction: parseFloat(e.target.value) / 100
                                })
                            })
                        }
                    />
                </Tooltip>
                <Tooltip content={`Flip kept ${this.clipTab} half-space (enables the plane)`} position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={this.isLoading}
                        onClick={() =>
                            this.applyProps({
                                clip: updateAxisClip(this.clip, this.clipTab, { enabled: true, invert: !tab.invert })
                            })
                        }
                    >
                        {tab.invert ? 'Unflip' : 'Flip'}
                    </button>
                </Tooltip>
            </span>
        );
    }

    protected renderContent(): React.ReactNode {
        if (this.isLoading && !this.model) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-spinner"></div>
                    <span>{this.statusMessage || 'Loading…'}</span>
                </div>
            );
        }
        return (
            <>
                <div className="openmc-output-viewer-viewarea">
                    <div className="openmc-output-viewer-hint">
                        {this.describeModel()}
                        {this.note ? ` — ${this.note}` : ''} Drag to orbit, wheel to zoom, right-drag to pan.
                    </div>
                    <div style={{ flex: '1', minHeight: '0', position: 'relative', display: 'flex' }}>
                        <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                        {this.renderNavCluster()}
                    </div>
                    {this.renderLegend()}
                </div>
            </>
        );
    }

    /** CAD-style nav cluster over the 3D viewarea, driving the orbit handle. */
    protected renderNavCluster(): React.ReactNode {
        return <ViewerNavCluster disabled={this.isLoading || !this.model} onAction={(action) => this.handleNavAction(action)} />;
    }

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

    protected renderLegend(): React.ReactNode {
        const selection = parseColorBy(this.colorBy);
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        if (!array) {
            return undefined;
        }
        const stops: string[] = [];
        for (let i = 0; i <= 8; i++) {
            const [r, g, b] = sampleNativeColormap(this.colormap, i / 8);
            stops.push(`rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`);
        }
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' }} title={`${array.name} range`}>
                <span style={{ fontSize: '11px' }}>{array.range[0].toPrecision(3)}</span>
                <div style={{ flex: '1', height: '10px', background: `linear-gradient(to right, ${stops.join(',')})` }} />
                <span style={{ fontSize: '11px' }}>{array.range[1].toPrecision(3)}</span>
                <span style={{ fontSize: '11px', opacity: 0.7 }}>{array.name}</span>
            </div>
        );
    }

    protected renderError(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-status error">
                <i className={codicon('error')}></i>
                <span>{this.error}</span>
                {this.fileUri && (
                    <button className="theia-button secondary" onClick={() => this.fileUri && this.setVtkFile(this.fileUri)}>
                        <i className={codicon('refresh')}></i>
                        Retry
                    </button>
                )}
            </div>
        );
    }

    // ------------------------------------------------------------------
    // three.js scene (built once per dataset; recolor rewrites colors only)
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
        if (!this.host || !this.isAttached) {
            return;
        }
        if (this.renderer) {
            // React may replace the host div between renders (spinner swaps
            // the whole subtree); the renderer's canvas went down with the
            // old node, so re-attach it instead of stranding an empty view.
            if (this.renderer.domElement.parentElement !== this.host) {
                this.host.appendChild(this.renderer.domElement);
                this.resizeRenderer();
                this.renderScene();
            }
            return;
        }
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        this.renderer.localClippingEnabled = true;
        this.host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        // Lit scene (same intensities as the DAGMC viewer): Lambert surfaces
        // shade with depth instead of rendering flat gray.
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(1, 2, 3);
        this.scene.add(directional);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.attachOrbitControls();
        this.attachContextMenu(this.renderer.domElement);
        this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
        if (this.host) {
            this.resizeObserver.observe(this.host);
        }
        this.resizeRenderer();
        if (this.model) {
            this.buildScene();
        } else {
            this.renderScene();
        }
    }
    private teardownRenderer(): void {
        this.contextMenuClose?.();
        this.contextMenuClose = undefined;
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        this.orbitControls?.dispose();
        this.orbitControls = undefined;
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
    }

    /** Rebuild the data group from the current model (new dataset only). */
    private buildScene(): void {
        const model = this.model;
        if (!model || !this.scene || !this.camera) {
            return;
        }
        if (this.dataGroup) {
            this.scene.remove(this.dataGroup);
            this.dataGroup.traverse((child) => {
                if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                    child.geometry.dispose();
                    const material = child.material as THREE.Material;
                    material.dispose();
                }
            });
            this.dataGroup = undefined;
        }
        this.dataGroup = new THREE.Group();
        if (model.triangles && model.triangles.length > 0) {
            // Surface datasets render filled triangles (lit, DoubleSide for
            // open shells); outlines/points come from the shading mode.
            const positions = this.triangleVertexPositions(model);
            this.dataGroup.add(this.buildTriangleMesh(positions));
            this.dataGroup.add(this.buildTrianglePoints(positions));
        } else if (model.segments) {
            // Line datasets also carry a point cloud over the same vertices
            // (shared position buffer, zero-copy) so `points` shading mode has
            // something to show; visibility picks one representation.
            const positions = this.lineVertexPositions(model);
            this.dataGroup.add(this.buildLineSegments(positions));
            this.dataGroup.add(this.buildLinePoints(positions));
        } else {
            this.dataGroup.add(this.buildPoints(model));
        }
        if (model.family !== 'polydata') {
            const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(this.decimatedPositions(model), 3));
            this.dataGroup.add(new THREE.Box3Helper(box, 0x888888));
        }
        this.scene.add(this.dataGroup);
        this.fitView();
        this.recolor();
    }

    /** Expanded per-corner positions for triangle datasets (non-indexed soup). */
    private triangleVertexPositions(model: NativeVtkModel): Float32Array {
        const triangles = model.triangles ?? new Uint32Array(0);
        const positions = new Float32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
            const point = triangles[i] * 3;
            positions[i * 3] = model.positions[point] ?? Number.NaN;
            positions[i * 3 + 1] = model.positions[point + 1] ?? Number.NaN;
            positions[i * 3 + 2] = model.positions[point + 2] ?? Number.NaN;
        }
        return positions;
    }

    /** Filled surface mesh (lit vertex colors; DoubleSide for open shells). */
    private buildTriangleMesh(positions: Float32Array): THREE.Mesh {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        // Non-indexed corner soup: per-corner normals give flat facet shading.
        geometry.computeVertexNormals();
        geometry.userData = { role: 'mesh' };
        const material = new THREE.MeshLambertMaterial({
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            side: THREE.DoubleSide
        });
        return new THREE.Mesh(geometry, material);
    }

    /** Corner points over triangle data (shares the corner buffer); shown in `points` mode. */
    private buildTrianglePoints(positions: Float32Array): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        geometry.userData = { role: 'mesh-points' };
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false
        });
        return new THREE.Points(geometry, material);
    }

    /** Expanded per-vertex positions for line-segment datasets. */
    private lineVertexPositions(model: NativeVtkModel): Float32Array {
        const segments = model.segments ?? new Uint32Array(0);
        const positions = new Float32Array(segments.length * 3);
        for (let i = 0; i < segments.length; i++) {
            const point = segments[i] * 3;
            positions[i * 3] = model.positions[point];
            positions[i * 3 + 1] = model.positions[point + 1];
            positions[i * 3 + 2] = model.positions[point + 2];
        }
        return positions;
    }

    private buildLineSegments(positions: Float32Array): THREE.LineSegments {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.opacity });
        return new THREE.LineSegments(geometry, material);
    }

    /** Point cloud over line vertices (shares the segment position buffer); shown in `points` mode. */
    private buildLinePoints(positions: Float32Array): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        geometry.userData = { role: 'line-points' };
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false
        });
        return new THREE.Points(geometry, material);
    }

    private buildPoints(model: NativeVtkModel): THREE.Points {
        const positions = this.decimatedPositions(model);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false
        });
        return new THREE.Points(geometry, material);
    }

    /** Evenly decimated positions for point clouds and grid centers. */
    private decimatedPositions(model: NativeVtkModel): Float32Array {
        const count = model.positions.length / 3;
        const stride = strideForBudget(count);
        if (stride <= 1) {
            return model.positions;
        }
        const kept = Math.ceil(count / stride);
        const out = new Float32Array(kept * 3);
        for (let i = 0; i < kept; i++) {
            out[i * 3] = model.positions[i * stride * 3];
            out[i * 3 + 1] = model.positions[i * stride * 3 + 1];
            out[i * 3 + 2] = model.positions[i * stride * 3 + 2];
        }
        return out;
    }

    /**
     * Instant recolor: rewrite vertex colors from the current color-by array
     * and colormap. No reload, no server restart — the random-ray restart hack
     * is structurally impossible on this path.
     */
    private recolor(): void {
        const model = this.model;
        if (!model || !this.dataGroup) {
            return;
        }
        this.note = '';
        const selection = parseColorBy(this.colorBy);
        const solid = new THREE.Color(this.solidColor);
        const paint = (geometry: THREE.BufferGeometry, colorAt: (vertex: number) => [number, number, number]): void => {
            // Box3Helper (grid bounds) carries no color attribute — leave it gray.
            const colors = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
            if (!colors) {
                return;
            }
            const count = geometry.getAttribute('position').count;
            for (let i = 0; i < count; i++) {
                const [r, g, b] = colorAt(i);
                colors.setXYZ(i, r, g, b);
            }
            colors.needsUpdate = true;
        };
        const solidAt = (): [number, number, number] => [solid.r, solid.g, solid.b];
        if (!selection || selection.kind === 'solid') {
            this.dataGroup.children.forEach((child) => {
                if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                    paint(child.geometry, solidAt);
                }
            });
            this.refreshView();
            return;
        }
        const array = this.findArray(selection.kind, selection.name);
        if (!array) {
            this.note = `'${this.colorBy}' is not in this file — showing Solid Color`;
            this.dataGroup.children.forEach((child) => {
                if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                    paint(child.geometry, solidAt);
                }
            });
            this.refreshView();
            return;
        }
        const [min, max] = array.range;
        const mapAt = (value: number): [number, number, number] =>
            Number.isFinite(value) ? sampleNativeColormap(this.colormap, normalizeToUnit(value, min, max)) : [solid.r, solid.g, solid.b];
        this.dataGroup.children.forEach((child) => {
            if (child instanceof THREE.LineSegments) {
                const segments = model.segments ?? new Uint32Array(0);
                const tupleOfVertex = this.lineTupleIndex(model, array, segments);
                paint(child.geometry, (vertex) => mapAt(tupleValue(array.values, array.components, tupleOfVertex(vertex))));
            } else if (child instanceof THREE.Mesh) {
                const triangles = model.triangles ?? new Uint32Array(0);
                const tupleOfVertex = this.meshTupleIndex(model, array, triangles);
                paint(child.geometry, (vertex) => mapAt(tupleValue(array.values, array.components, tupleOfVertex(vertex))));
            } else if (child instanceof THREE.Points) {
                const role = child.geometry.userData?.['role'];
                if (role === 'mesh-points' && model.triangles) {
                    const tupleOfVertex = this.meshTupleIndex(model, array, model.triangles);
                    paint(child.geometry, (vertex) => mapAt(tupleValue(array.values, array.components, tupleOfVertex(vertex))));
                } else if (role === 'line-points' && model.segments) {
                    const segments = model.segments;
                    const tupleOfVertex = this.lineTupleIndex(model, array, segments);
                    paint(child.geometry, (vertex) => mapAt(tupleValue(array.values, array.components, tupleOfVertex(vertex))));
                } else {
                    const tupleOfVertex = this.pointTupleIndex(model, array);
                    paint(child.geometry, (vertex) => mapAt(tupleValue(array.values, array.components, tupleOfVertex(vertex))));
                }
            }
        });
        this.refreshView();
    }

    /** Cell/point tuple index for each line-segment vertex. */
    private lineTupleIndex(model: NativeVtkModel, array: NativeVtkDataArray, segments: Uint32Array): (vertex: number) => number {
        if (array.association === 'point') {
            return (vertex) => segments[vertex];
        }
        const cells = model.segmentCells;
        if (cells && cells.length * 2 === segments.length) {
            return (vertex) => cells[Math.floor(vertex / 2)];
        }
        return () => -1;
    }

    /** Cell/point tuple index for each triangle corner (non-indexed soup: corner v of triangle floor(v/3)). */
    private meshTupleIndex(model: NativeVtkModel, array: NativeVtkDataArray, triangles: Uint32Array): (vertex: number) => number {
        if (array.association === 'point') {
            return (vertex) => triangles[vertex] ?? -1;
        }
        const cells = model.triangleCells;
        if (cells && cells.length * 3 === triangles.length) {
            return (vertex) => cells[Math.floor(vertex / 3)];
        }
        return () => -1;
    }

    /** Tuple index for each rendered point (decimation-aware for clouds/grids). */
    private pointTupleIndex(model: NativeVtkModel, array: NativeVtkDataArray): (vertex: number) => number {
        if (model.segments) {
            // Should not happen (lines take the segment path), but stay total.
            return () => -1;
        }
        if (array.association === 'cell' && model.family === 'polydata' && model.vertices) {
            const verts = model.vertices;
            if (array.values.length / Math.max(1, array.components) >= verts.length) {
                const stride = strideForBudget(model.positions.length / 3);
                return (vertex) => vertex * stride;
            }
            return () => -1;
        }
        if (array.association === 'point' && model.family !== 'polydata') {
            return () => -1;
        }
        const stride = strideForBudget(model.positions.length / 3);
        return (vertex) => vertex * stride;
    }

    private syncMaterialProps(): void {
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        this.dataGroup?.children.forEach((child) => {
            // Box3Helper (grid bounds) carries no color attribute — leave it alone.
            if (child instanceof THREE.Box3Helper) {
                return;
            }
            if (child instanceof THREE.Points) {
                const material = child.material as THREE.PointsMaterial;
                material.size = this.pointSize;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
            } else if (child instanceof THREE.LineSegments) {
                const material = child.material as THREE.LineBasicMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
            } else if (child instanceof THREE.Mesh) {
                // Lambert supports wireframe/opacity/depthWrite; emissive stays untouched.
                const material = child.material as THREE.MeshLambertMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
                material.wireframe = flags.wireframe;
            }
        });
    }

    /** Toggle line/point visibility for `points` mode; the bounds helper stays visible. */
    private applyShadingVisibility(): void {
        if (!this.dataGroup) {
            return;
        }
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        this.dataGroup.children.forEach((child) => {
            if (child instanceof THREE.Box3Helper) {
                child.visible = true;
            } else if (child instanceof THREE.Points) {
                const role = child.geometry.userData?.['role'];
                child.visible = role === 'line-points' || role === 'mesh-points' ? flags.pointsOnly : true;
            } else if (child instanceof THREE.LineSegments) {
                child.visible = !flags.pointsOnly;
            } else if (child instanceof THREE.Mesh) {
                child.visible = !flags.pointsOnly;
            }
        });
    }

    /** Apply the viewer-core per-axis clip state to every data material (three.js native clipping). */
    private applyClip(): void {
        if (!this.dataGroup) {
            return;
        }
        const planes = this.toThreePlanes();
        this.dataGroup.children.forEach((child) => {
            if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                (child.material as THREE.Material).clippingPlanes = planes;
            }
        });
    }

    private toThreePlanes(): THREE.Plane[] {
        if (!this.model) {
            return [];
        }
        const bounds = boundingBoxFromPositions(this.model.positions);
        if (!bounds) {
            return [];
        }
        return toThreePlaneParamsArray(this.clip, bounds).map(
            (params) => new THREE.Plane(new THREE.Vector3(...params.normal), params.constant)
        );
    }

    /** Re-apply material props, shading visibility, and clip, then repaint. */
    private refreshView(): void {
        this.syncMaterialProps();
        this.applyShadingVisibility();
        this.applyClip();
        this.renderScene();
    }

    private findArray(kind: 'point' | 'cell', name: string): NativeVtkDataArray | undefined {
        const list = kind === 'point' ? this.model?.pointArrays : this.model?.cellArrays;
        return list?.find((array) => array.name === name);
    }

    private hasArray(colorBy: string): boolean {
        const selection = parseColorBy(colorBy);
        return !selection || selection.kind === 'solid' || this.findArray(selection.kind, selection.name) !== undefined;
    }

    private describeModel(): string {
        const model = this.model;
        if (!model) {
            return this.isLoading ? this.statusMessage : 'No dataset loaded';
        }
        if (model.family === 'polydata') {
            const parts: string[] = [];
            if (model.triangles) {
                parts.push(`${(model.triangles.length / 3).toLocaleString()} triangles`);
            }
            if (model.segments) {
                parts.push(`${(model.segments.length / 2).toLocaleString()} segments`);
            }
            if (model.vertices) {
                parts.push(`${model.vertices.length.toLocaleString()} points`);
            }
            if (parts.length === 0) {
                parts.push(`${model.nPoints.toLocaleString()} points`);
            }
            return `PolyData — ${parts.join(' + ')}`;
        }
        const [nx, ny, nz] = model.gridDimensions ?? [0, 0, 0];
        const kind = model.family === 'rectilinear' ? 'RectilinearGrid' : 'ImageData';
        return `${kind} — ${model.nPoints.toLocaleString()} cells (${nx} × ${ny} × ${nz}, cell-center preview)`;
    }

    // ------------------------------------------------------------------
    // Orbit navigation (three.js OrbitControls via the shared viewer-core
    // helper; gestures render on demand through `renderScene`)
    // ------------------------------------------------------------------

    /**
     * Right-click (no-drag) opens the view-action context menu. OrbitControls
     * owns right-drag pan on the same canvas, so the menu only opens when
     * the release lands within ~5px of the press.
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

    /** View-action menu: fit, screenshot, clip toggle, shading cycle. */
    private openContextMenu(clientX: number, clientY: number): void {
        if (!this.model) {
            return;
        }
        this.contextMenuClose?.();
        const shadingLabel = VIEWER_SHADING_MODES.find((mode) => mode.id === this.shading)?.label ?? this.shading;
        this.contextMenuClose = openViewerContextMenu(
            { x: clientX, y: clientY },
            [
                { id: 'fit', label: 'Fit to View' },
                { id: 'screenshot', label: 'Save Screenshot (PNG)' },
                { id: 'clip', label: 'Clip Planes', checked: anyClipEnabled(this.clip) },
                { id: 'shading', label: `Shading: ${shadingLabel}` }
            ],
            (id) => this.handleContextMenuAction(id)
        );
    }

    private handleContextMenuAction(id: string): void {
        if (id === 'fit') {
            this.fitView();
        } else if (id === 'screenshot') {
            this.saveScreenshot();
        } else if (id === 'clip') {
            this.applyProps({ clip: setAllClipEnabled(this.clip, !anyClipEnabled(this.clip)) });
        } else if (id === 'shading') {
            this.applyProps({ shading: nextViewerShadingMode(this.shading) });
        }
        this.update();
    }

    /**
     * Attach OrbitControls to the renderer canvas. The controls class loads
     * asynchronously (same dynamic import style as nuke-cad); a renderer
     * teardown before the import resolves disposes the stale handle. Once
     * attached, the loaded dataset is framed through the controls.
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
                console.warn('[NativeVtkViewer] Failed to load orbit controls:', error);
            });
    }
}
