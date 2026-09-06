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
    parseNativeVtkXml,
    sampleNativeColormap,
    SOLID_COLOR,
    strideForBudget,
    tupleValue
} from './native-vtk/native-vtk-data';
import { OpenMCVtkArrayInfo } from '../../../../common/openmc-protocol';
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
}

/** Orbit state for the viewer's minimal built-in navigation. */
interface NativeVtkOrbit {
    theta: number;
    phi: number;
    distance: number;
    target: THREE.Vector3;
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
    static readonly ID = 'native-vtk-viewer-widget';
    static readonly LABEL = 'Native VTK Viewer';

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
    private orbit: NativeVtkOrbit | undefined;
    private resizeObserver: ResizeObserver | undefined;

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
            opacity: this.opacity
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
            const content = await this.fileService.read(uri);
            if (token !== this.loadToken) {
                return;
            }
            await this.setVtkText(content.value.toString(), token);
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
            const model = await parseNativeVtkXml(text);
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

    /** Frame the loaded dataset. */
    fitView(): void {
        const model = this.model;
        if (!model || !this.camera || !this.orbit) {
            return;
        }
        const box = new THREE.Box3();
        const positions = model.positions;
        for (let i = 0; i < positions.length; i += 3) {
            box.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
        }
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        this.orbit.target.copy(sphere.center);
        this.orbit.distance = Math.max(sphere.radius * 2.2, 1e-6);
        this.applyOrbit();
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
                <button
                    className={`theia-button${this.colorBy === SOLID_COLOR ? '' : ' secondary'}`}
                    onClick={() => this.applyProps({ colorBy: SOLID_COLOR })}
                    disabled={this.isLoading || !this.model}
                    title="Solid color (no data mapping)"
                >
                    Solid
                </button>
                <button
                    className="theia-button secondary"
                    onClick={() => this.fitView()}
                    disabled={this.isLoading || !this.model}
                    title="Fit view to dataset"
                >
                    <i className={codicon('screen-full')}></i>
                </button>
                <button
                    className="theia-button secondary"
                    onClick={() => this.saveScreenshot()}
                    disabled={this.isLoading || !this.model}
                    title="Download PNG screenshot"
                >
                    <i className={codicon('device-camera')}></i>
                </button>
                <button
                    className="theia-button secondary"
                    onClick={() => this.fileUri && this.setVtkFile(this.fileUri)}
                    disabled={this.isLoading || !this.fileUri}
                    title="Reload file"
                >
                    <i className={codicon('refresh')}></i>
                </button>
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
            <label className="openmc-output-viewer-control" title="Color-by array (applies instantly, no viewer restart)">
                Color by
                <select value={this.colorBy} onChange={(e) => this.applyProps({ colorBy: e.target.value })} disabled={this.isLoading}>
                    {options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    protected renderColormapSelect(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        return (
            <label className="openmc-output-viewer-control" title="Colormap (applies instantly)">
                Map
                <select
                    value={this.colormap}
                    onChange={(e) => this.applyProps({ colormap: e.target.value as NativeVtkColormapName })}
                    disabled={this.isLoading}
                >
                    {NATIVE_VTK_COLORMAPS.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>
            </label>
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
                    <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                    {this.renderLegend()}
                </div>
            </>
        );
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
        if (this.renderer || !this.host || !this.isAttached) {
            return;
        }
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        this.host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.orbit = { theta: Math.PI / 4, phi: Math.PI / 3, distance: 10, target: new THREE.Vector3() };
        this.attachOrbitHandlers(this.renderer.domElement);
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

    /** Rebuild the data group from the current model (new dataset only). */
    private buildScene(): void {
        const model = this.model;
        if (!model || !this.scene || !this.camera || !this.orbit) {
            return;
        }
        if (this.dataGroup) {
            this.scene.remove(this.dataGroup);
            this.dataGroup.traverse((child) => {
                if (child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                    child.geometry.dispose();
                    const material = child.material as THREE.Material;
                    material.dispose();
                }
            });
            this.dataGroup = undefined;
        }
        this.dataGroup = new THREE.Group();
        if (model.segments) {
            this.dataGroup.add(this.buildLineSegments(model));
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

    private buildLineSegments(model: NativeVtkModel): THREE.LineSegments {
        const segments = model.segments ?? new Uint32Array(0);
        const positions = new Float32Array(segments.length * 3);
        for (let i = 0; i < segments.length; i++) {
            const point = segments[i] * 3;
            positions[i * 3] = model.positions[point];
            positions[i * 3 + 1] = model.positions[point + 1];
            positions[i * 3 + 2] = model.positions[point + 2];
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.opacity });
        return new THREE.LineSegments(geometry, material);
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
            const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
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
                if (child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                    paint(child.geometry, solidAt);
                }
            });
            this.syncMaterialProps();
            this.renderScene();
            return;
        }
        const array = this.findArray(selection.kind, selection.name);
        if (!array) {
            this.note = `'${this.colorBy}' is not in this file — showing Solid Color`;
            this.dataGroup.children.forEach((child) => {
                if (child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                    paint(child.geometry, solidAt);
                }
            });
            this.syncMaterialProps();
            this.renderScene();
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
            } else if (child instanceof THREE.Points) {
                const tupleOfVertex = this.pointTupleIndex(model, array);
                paint(child.geometry, (vertex) => mapAt(tupleValue(array.values, array.components, tupleOfVertex(vertex))));
            }
        });
        this.syncMaterialProps();
        this.renderScene();
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
        this.dataGroup?.children.forEach((child) => {
            if (child instanceof THREE.Points) {
                const material = child.material as THREE.PointsMaterial;
                material.size = this.pointSize;
                material.opacity = this.opacity;
            } else if (child instanceof THREE.LineSegments) {
                const material = child.material as THREE.LineBasicMaterial;
                material.opacity = this.opacity;
            }
        });
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
    // Minimal orbit navigation (rotate / zoom / pan + fit)
    // ------------------------------------------------------------------

    private attachOrbitHandlers(canvas: HTMLCanvasElement): void {
        let dragging = false;
        let button = 0;
        let lastX = 0;
        let lastY = 0;
        canvas.addEventListener('pointerdown', (e) => {
            dragging = true;
            button = e.button;
            lastX = e.clientX;
            lastY = e.clientY;
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
            } else {
                this.orbit.theta -= dx * 0.005;
                this.orbit.phi = Math.min(Math.PI - 0.01, Math.max(0.01, this.orbit.phi - dy * 0.005));
                this.applyOrbit();
            }
        });
        const stop = (): void => {
            dragging = false;
        };
        canvas.addEventListener('pointerup', stop);
        canvas.addEventListener('pointercancel', stop);
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
