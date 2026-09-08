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
    normalizeToUnit,
    parseColorBy,
    readVtkText,
    sampleNativeColormap,
    SOLID_COLOR,
    tupleValue
} from '../native-vtk/native-vtk-data';
import { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import { DEFAULT_VIEWER_TOOLBAR_STATE } from '../../../../viewer-core/viewer-toolbar-model';
import {
    anyClipEnabled,
    AxisAlignedBounds,
    CLIP_AXES,
    ClipAxis,
    ClipPlanesState,
    createClipPlanesState,
    setAllClipEnabled,
    toThreePlaneParamsArray,
    updateAxisClip
} from '../../../../viewer-core/clip-plane';
import { createOrbitControls, standardViewDirection, type OrbitControlsHandle } from '../../../../viewer-core/orbit-controls';
import { isViewerContextMenuClick, openViewerContextMenu } from '../../../../viewer-core/viewer-context-menu';
import {
    DEFAULT_VIEWER_SHADING_MODE,
    VIEWER_SHADING_MODES,
    ViewerShadingMode,
    isViewerShadingMode,
    nextViewerShadingMode,
    resolveViewerShadingFlags
} from '../../../../viewer-core/shading-mode';
import { DagmcBlockModel, mergeDagmcBounds, parseBlockDataset, parseVtmManifest } from './dagmc-multiblock';
import {
    DagmcModelInfo,
    DagmcVisibility,
    createDefaultDagmcVisibility,
    groupsOfVolume,
    isDagmcVolumeVisible,
    parseDagmcModelInfo,
    setDagmcShowGraveyard,
    showAllDagmc,
    toggleDagmcGroup,
    toggleDagmcMaterial,
    toggleDagmcVolume,
    visibleDagmcVolumeIds
} from './dagmc-toggle-model';
import { ViewerNavAction, ViewerNavCluster } from '../viewer-nav-cluster';
import '../output-viewer.css';

/**
 * Props driving the native DAGMC viewer. Every field applies instantly to
 * the already-loaded blocks — toggling volumes, switching color-by, or
 * moving the clip planes never restarts anything (there is no trame server;
 * this is the P2-C2 replacement for the `dagmc_viz.py` ExtractBlock UI).
 */
export interface DagmcViewerProps {
    /** `'Solid Color'`, `'Point: <name>'`, or `'Cell: <name>'` (base.serve format). */
    colorBy?: string;
    /** One of the six short colormaps (viewer-core LUT pack). */
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
    /** Volume/material/group visibility (toggle model). */
    visibility?: DagmcVisibility;
}

/** Render-vertex kind used to map vertices back to data tuples. */
type DagmcRenderKind = 'mesh' | 'edges' | 'lines' | 'points';

const VOLUME_BLOCK_RE = /^Volume_(\d+)$/;

/**
 * Native DAGMC viewer widget (P2-C2): renders multiblock `.vtm` volume sets
 * (as written by `convert_h5m_to_multiblock_vtk`) directly in the IDE with
 * three.js — no trame server, no reverse proxy, no iframe. The manifest is
 * read through Theia's `FileService`, each block file is resolved against
 * the manifest URI and parsed client-side, model metadata arrives via
 * `setModelInfo` (the `dagmc.info` JSON channel), and volume / material /
 * group toggles plus the per-axis clip planes apply instantly.
 *
 * This widget is intentionally NOT wired into any contribution yet: the
 * parent phase registers the opener, feeds it the converter output paths,
 * and calls `setModelInfo` with the `dagmc.info` payload.
 */
@injectable()
export class DagmcViewerWidget extends ReactWidget {
    static readonly ID: string = 'dagmc-viewer-widget';
    static readonly LABEL: string = 'Native DAGMC Viewer';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected vtmUri: URI | undefined;
    protected blocks: DagmcBlockModel[] = [];
    protected modelInfo: DagmcModelInfo | undefined;
    protected classified: ClassifiedNativeVtkArrays | undefined;
    protected visibility: DagmcVisibility = createDefaultDagmcVisibility();
    protected colorBy: string = SOLID_COLOR;
    protected colormap: NativeVtkColormapName = DEFAULT_COLORMAP;
    protected solidColor = '#d4d4d4';
    protected pointSize = DEFAULT_VIEWER_TOOLBAR_STATE.pointSize;
    protected opacity = DEFAULT_VIEWER_TOOLBAR_STATE.opacity;
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
        this.id = DagmcViewerWidget.ID;
        this.title.label = DagmcViewerWidget.LABEL;
        this.title.iconClass = codicon('layers');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    // ------------------------------------------------------------------
    // Public props API (instant, no restart)
    // ------------------------------------------------------------------

    getProps(): DagmcViewerProps {
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
            },
            visibility: { ...this.visibility }
        };
    }

    /** Apply viewer props; visibility/color/clip changes take effect immediately. */
    applyProps(props: DagmcViewerProps): void {
        let structureChanged = false;
        let styleChanged = false;
        if (props.colorBy !== undefined && props.colorBy !== this.colorBy) {
            this.colorBy = props.colorBy;
            styleChanged = true;
        }
        if (props.colormap !== undefined && NATIVE_VTK_COLORMAPS.includes(props.colormap) && props.colormap !== this.colormap) {
            this.colormap = props.colormap;
            styleChanged = true;
        }
        if (props.solidColor !== undefined && props.solidColor !== this.solidColor) {
            this.solidColor = props.solidColor;
            styleChanged = true;
        }
        if (props.pointSize !== undefined && props.pointSize > 0 && props.pointSize !== this.pointSize) {
            this.pointSize = props.pointSize;
            styleChanged = true;
        }
        if (props.opacity !== undefined) {
            const opacity = Math.min(1, Math.max(0, props.opacity));
            if (opacity !== this.opacity) {
                this.opacity = opacity;
                styleChanged = true;
            }
        }
        if (props.shading !== undefined && isViewerShadingMode(props.shading) && props.shading !== this.shading) {
            this.shading = props.shading;
            styleChanged = true;
        }
        if (props.clip !== undefined) {
            this.clip = props.clip;
            styleChanged = true;
        }
        if (props.visibility !== undefined) {
            this.visibility = props.visibility;
            structureChanged = true;
        }
        if (structureChanged) {
            this.buildScene();
        } else if (styleChanged) {
            this.recolor();
            this.applyClip();
            this.applyShadingVisibility();
            this.syncMaterialProps();
            this.renderScene();
        }
        this.update();
    }

    /** Load a `.vtm` manifest through Theia's FileService (no HTTP fetch). */
    async setVtmFile(uri: URI): Promise<void> {
        this.vtmUri = uri;
        this.id = `${DagmcViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${DagmcViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${DagmcViewerWidget.LABEL}: ${uri.path.toString()}`;
        const token = ++this.loadToken;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Reading multiblock manifest…';
        this.update();
        try {
            const text = await readVtkText(this.fileService, uri);
            if (token !== this.loadToken) {
                return;
            }
            await this.setVtmText(text, token);
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to load DAGMC manifest: ${this.error}`);
            this.update();
        }
    }

    /** Load an already-read `.vtm` manifest, expanding blocks via FileService. */
    async setVtmText(text: string, token = ++this.loadToken): Promise<void> {
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Expanding multiblock volumes…';
        this.update();
        try {
            const refs = parseVtmManifest(text);
            const models: DagmcBlockModel[] = [];
            for (const ref of refs) {
                const blockUri = this.vtmUri ? this.vtmUri.parent.resolve(ref.file) : undefined;
                if (!blockUri) {
                    throw new Error(`Cannot resolve block '${ref.name}': no manifest URI is set`);
                }
                this.statusMessage = `Reading ${ref.name}…`;
                this.update();
                const text = await readVtkText(this.fileService, blockUri);
                if (token !== this.loadToken) {
                    return;
                }
                models.push(await parseBlockDataset(ref.file, text, ref.name, ref.index));
            }
            if (token !== this.loadToken) {
                return;
            }
            this.blocks = models.sort((a, b) => a.blockIndex - b.blockIndex);
            this.classified = classifyNativeVtkArrays(this.blocks.flatMap((block) => [...block.pointArrays, ...block.cellArrays]));
            const fallback = this.blocks.length > 0 ? defaultNativeColorBy(this.classified, 'polydata') : undefined;
            if (parseColorBy(this.colorBy) === undefined || (fallback && !this.hasArray(this.colorBy))) {
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
            this.messageService.error(`Failed to expand DAGMC multiblock: ${this.error}`);
            this.update();
        }
    }

    /** Store validated `dagmc.info` model metadata driving the toggle panel. */
    setModelInfo(value: unknown): void {
        this.modelInfo = parseDagmcModelInfo(value);
        this.buildScene();
        this.update();
    }

    /** Download a PNG screenshot of the current canvas. */
    saveScreenshot(): void {
        if (!this.renderer || this.blocks.length === 0) {
            return;
        }
        this.renderScene();
        const url = this.renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.vtmUri?.path.base ?? 'dagmc'}.png`;
        link.click();
    }

    /** Frame all visible blocks through the orbit controls (target + distance). */
    fitView(): void {
        const bounds = mergeDagmcBounds(this.visibleBlocks());
        if (!bounds || !this.camera || !this.orbitControls) {
            return;
        }
        this.orbitControls.fitBounds(bounds.min, bounds.max);
    }

    // ------------------------------------------------------------------
    // Visibility helpers
    // ------------------------------------------------------------------

    /** Volume id for `Volume_<id>` block names; unknown schemes stay visible. */
    protected blockVolumeId(block: DagmcBlockModel): number | undefined {
        const match = VOLUME_BLOCK_RE.exec(block.blockName);
        return match ? parseInt(match[1], 10) : undefined;
    }

    protected isBlockVisible(block: DagmcBlockModel): boolean {
        if (!this.modelInfo) {
            return true;
        }
        const volumeId = this.blockVolumeId(block);
        return volumeId === undefined || isDagmcVolumeVisible(this.visibility, this.modelInfo, volumeId);
    }

    protected visibleBlocks(): DagmcBlockModel[] {
        return this.blocks.filter((block) => this.isBlockVisible(block));
    }

    protected setVisibility(visibility: DagmcVisibility): void {
        this.visibility = visibility;
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
        const fileName = this.vtmUri?.path.base ?? 'No manifest loaded';
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
                        disabled={this.isLoading || this.blocks.length === 0}
                    >
                        <i className={codicon('device-camera')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Reload manifest" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.vtmUri && this.setVtmFile(this.vtmUri)}
                        disabled={this.isLoading || !this.vtmUri}
                    >
                        <i className={codicon('refresh')}></i>
                    </button>
                </Tooltip>
            </div>
        );
    }

    protected renderColorBySelect(): React.ReactNode {
        if (this.blocks.length === 0 || !this.classified) {
            return undefined;
        }
        const options: { value: string; label: string }[] = [{ value: SOLID_COLOR, label: SOLID_COLOR }];
        const push = (arrays: OpenMCVtkArrayInfo[]): void => {
            for (const array of arrays) {
                const value = colorByValue(array);
                if (!options.some((option) => option.value === value)) {
                    options.push({ value, label: `${array.association === 'point' ? 'Point' : 'Cell'}: ${array.name}` });
                }
            }
        };
        push(this.classified.energies);
        push(this.classified.fluxGroups);
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
        if (this.blocks.length === 0) {
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
        if (this.blocks.length === 0) {
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

    protected renderContent(): React.ReactNode {
        if (this.isLoading && this.blocks.length === 0) {
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
                        {this.describeBlocks()}
                        {this.note ? ` — ${this.note}` : ''} Drag to orbit, wheel to zoom, right-drag to pan.
                    </div>
                    <div style={{ flex: '1', minHeight: '0', position: 'relative', display: 'flex' }}>
                        <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                        {this.renderNavCluster()}
                    </div>
                    {this.renderLegend()}
                </div>
                {this.renderSidePanel()}
            </>
        );
    }

    /** CAD-style nav cluster over the 3D viewarea, driving the orbit handle. */
    protected renderNavCluster(): React.ReactNode {
        return (
            <ViewerNavCluster disabled={this.isLoading || this.blocks.length === 0} onAction={(action) => this.handleNavAction(action)} />
        );
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

    protected renderSidePanel(): React.ReactNode {
        if (this.blocks.length === 0) {
            return undefined;
        }
        return <div style={{ display: 'flex', gap: '16px', padding: '4px 8px', flexWrap: 'wrap' }}>{this.renderToggleControls()}</div>;
    }

    protected renderClipControls(): React.ReactNode {
        if (this.blocks.length === 0) {
            return undefined;
        }
        const bounds: AxisAlignedBounds | undefined = mergeDagmcBounds(this.visibleBlocks());
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

    protected renderToggleControls(): React.ReactNode {
        if (!this.modelInfo) {
            return (
                <span style={{ fontSize: '11px', opacity: 0.7 }} title="Call setModelInfo with the dagmc.info payload to enable toggles">
                    Volume toggles need model info (dagmc.info)
                </span>
            );
        }
        const info = this.modelInfo;
        const visible = this.modelInfo ? visibleDagmcVolumeIds(this.visibility, this.modelInfo).length : 0;
        return (
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '11px' }}>
                <span title="Visible volumes">
                    {visible} of {info.volumes.length} volumes
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Show graveyard termination volumes">
                    <input
                        type="checkbox"
                        checked={this.visibility.showGraveyard}
                        onChange={(e) => this.setVisibility(setDagmcShowGraveyard(this.visibility, e.target.checked))}
                    />
                    Graveyard
                </label>
                <label title="Volume visibility">
                    Volumes
                    <select
                        value=""
                        onChange={(e) => {
                            if (e.target.value !== '') {
                                this.setVisibility(toggleDagmcVolume(this.visibility, parseInt(e.target.value, 10)));
                            }
                        }}
                    >
                        <option value="">Toggle volume…</option>
                        {info.volumes.map((volume) => {
                            const groups = groupsOfVolume(info, volume.id);
                            const suffix = groups.length > 0 ? ` [${groups.join(', ')}]` : '';
                            return (
                                <option key={volume.id} value={volume.id}>
                                    {`${this.visibility.hiddenVolumes.includes(volume.id) ? '○' : '●'} ${volume.id} (${volume.material}, ${volume.numTriangles} tris)${suffix}`}
                                </option>
                            );
                        })}
                    </select>
                </label>
                <label title="Material visibility">
                    Materials
                    <select
                        value=""
                        onChange={(e) => {
                            if (e.target.value !== '') {
                                this.setVisibility(toggleDagmcMaterial(this.visibility, e.target.value));
                            }
                        }}
                    >
                        <option value="">Toggle material…</option>
                        {Object.keys(info.materials).map((material) => (
                            <option key={material} value={material}>
                                {`${this.visibility.hiddenMaterials.includes(material) ? '○' : '●'} ${material}`}
                            </option>
                        ))}
                    </select>
                </label>
                <label title="Group visibility">
                    Groups
                    <select
                        value=""
                        onChange={(e) => {
                            if (e.target.value !== '') {
                                this.setVisibility(toggleDagmcGroup(this.visibility, e.target.value));
                            }
                        }}
                    >
                        <option value="">Toggle group…</option>
                        {Object.keys(info.groups).map((group) => (
                            <option key={group} value={group}>
                                {`${this.visibility.hiddenGroups.includes(group) ? '○' : '●'} ${group}`}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    className="theia-button secondary"
                    title="Show every volume"
                    onClick={() => this.setVisibility(showAllDagmc(this.visibility))}
                >
                    Show all
                </button>
            </div>
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
                {this.vtmUri && (
                    <button className="theia-button secondary" onClick={() => this.vtmUri && this.setVtmFile(this.vtmUri)}>
                        <i className={codicon('refresh')}></i>
                        Retry
                    </button>
                )}
            </div>
        );
    }

    // ------------------------------------------------------------------
    // three.js scene (rebuilt on structure change; recolor rewrites colors)
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
        this.attachOrbitControls();
        this.attachContextMenu(this.renderer.domElement);
        this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
        if (this.host) {
            this.resizeObserver.observe(this.host);
        }
        this.resizeRenderer();
        if (this.blocks.length > 0) {
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

    private disposeGroup(group: THREE.Group): void {
        group.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                child.geometry.dispose();
                const material = child.material as THREE.Material;
                material.dispose();
            }
        });
    }

    /** Rebuild the data group from the visible blocks (new dataset or toggle change). */
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
        for (const block of this.visibleBlocks()) {
            const group = new THREE.Group();
            group.name = `block:${block.blockIndex}`;
            for (const object of this.buildBlockObjects(block)) {
                group.add(object);
            }
            this.dataGroup.add(group);
        }
        this.scene.add(this.dataGroup);
        this.fitView();
        this.recolor();
        this.applyClip();
        this.applyShadingVisibility();
        this.syncMaterialProps();
        this.renderScene();
    }

    private buildBlockObjects(block: DagmcBlockModel): THREE.Object3D[] {
        if (block.triangles && block.triangles.length > 0) {
            // Mesh blocks also carry a point cloud over the same vertices
            // (shared position buffer, zero-copy) so `points` shading mode has
            // something to show; visibility picks the representation.
            const positions = this.blockMeshPositions(block);
            return [this.buildBlockMesh(block, positions), this.buildBlockEdges(block), this.buildBlockPointCloud(block, positions)];
        }
        if (block.segments && block.segments.length > 0) {
            return [this.buildBlockLines(block)];
        }
        return [this.buildBlockPoints(block)];
    }

    private makeColorAttribute(count: number): THREE.BufferAttribute {
        return new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    }

    /** Expanded per-vertex positions for triangle-mesh blocks. */
    private blockMeshPositions(block: DagmcBlockModel): Float32Array {
        const triangles = block.triangles ?? new Uint32Array(0);
        const positions = new Float32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
            const point = triangles[i] * 3;
            positions[i * 3] = block.positions[point];
            positions[i * 3 + 1] = block.positions[point + 1];
            positions[i * 3 + 2] = block.positions[point + 2];
        }
        return positions;
    }

    private buildBlockMesh(block: DagmcBlockModel, positions: Float32Array): THREE.Mesh {
        const triangles = block.triangles ?? new Uint32Array(0);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(triangles.length));
        geometry.computeVertexNormals();
        geometry.userData = { blockIndex: block.blockIndex, kind: 'mesh' as DagmcRenderKind };
        const material = new THREE.MeshLambertMaterial({
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            side: THREE.DoubleSide
        });
        return new THREE.Mesh(geometry, material);
    }

    /** Point cloud over mesh vertices (shares the mesh position buffer); shown in `points` mode. */
    private buildBlockPointCloud(block: DagmcBlockModel, positions: Float32Array): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(positions.length / 3));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'mesh' as DagmcRenderKind, role: 'mesh-points' };
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

    private buildBlockEdges(block: DagmcBlockModel): THREE.LineSegments {
        const triangles = block.triangles ?? new Uint32Array(0);
        const pairs: number[] = [];
        for (let t = 0; t + 2 < triangles.length; t += 3) {
            pairs.push(triangles[t], triangles[t + 1], triangles[t + 1], triangles[t + 2], triangles[t + 2], triangles[t]);
        }
        const positions = new Float32Array(pairs.length * 3);
        for (let i = 0; i < pairs.length; i++) {
            const point = pairs[i] * 3;
            positions[i * 3] = block.positions[point];
            positions[i * 3 + 1] = block.positions[point + 1];
            positions[i * 3 + 2] = block.positions[point + 2];
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(pairs.length));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'edges' as DagmcRenderKind };
        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: Math.min(1, this.opacity + 0.2) });
        return new THREE.LineSegments(geometry, material);
    }

    private buildBlockLines(block: DagmcBlockModel): THREE.LineSegments {
        const segments = block.segments ?? new Uint32Array(0);
        const positions = new Float32Array(segments.length * 3);
        for (let i = 0; i < segments.length; i++) {
            const point = segments[i] * 3;
            positions[i * 3] = block.positions[point];
            positions[i * 3 + 1] = block.positions[point + 1];
            positions[i * 3 + 2] = block.positions[point + 2];
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(segments.length));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'lines' as DagmcRenderKind };
        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.opacity });
        return new THREE.LineSegments(geometry, material);
    }

    private buildBlockPoints(block: DagmcBlockModel): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(block.positions.slice(), 3));
        geometry.setAttribute('color', this.makeColorAttribute(block.positions.length / 3));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'points' as DagmcRenderKind };
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

    /**
     * Data-tuple index per render vertex for one object kind (-1 = solid).
     * Mesh/edge vertices map through the triangle index; line vertices map
     * through segment endpoints/cells; point vertices map by position index.
     */
    private tupleMap(block: DagmcBlockModel, kind: DagmcRenderKind, association: 'point' | 'cell'): Int32Array {
        if (kind === 'mesh' || kind === 'edges') {
            const triangles = block.triangles ?? new Uint32Array(0);
            const perTri = kind === 'mesh' ? 3 : 6;
            const triCount = Math.floor(triangles.length / 3);
            const map = new Int32Array(triCount * perTri).fill(-1);
            const tupleCount = association === 'point' ? block.nPoints : this.cellTupleCount(block);
            for (let t = 0; t < triCount; t++) {
                for (let k = 0; k < perTri; k++) {
                    const point = kind === 'mesh' ? triangles[t * 3 + k] : triangles[t * 3 + [0, 1, 1, 2, 2, 0][k]];
                    const tuple = association === 'point' ? point : block.triangleCells ? block.triangleCells[t] : t;
                    map[t * perTri + k] = tuple >= 0 && tuple < tupleCount ? tuple : -1;
                }
            }
            return map;
        }
        if (kind === 'lines') {
            const segments = block.segments ?? new Uint32Array(0);
            const map = new Int32Array(segments.length).fill(-1);
            const tupleCount = association === 'point' ? block.nPoints : this.cellTupleCount(block);
            for (let v = 0; v < segments.length; v++) {
                const tuple =
                    association === 'point'
                        ? segments[v]
                        : block.segmentCells && block.segmentCells.length * 2 === segments.length
                          ? block.segmentCells[Math.floor(v / 2)]
                          : -1;
                map[v] = tuple >= 0 && tuple < tupleCount ? tuple : -1;
            }
            return map;
        }
        const count = Math.floor(block.positions.length / 3);
        const map = new Int32Array(count).fill(-1);
        const tupleCount = association === 'point' ? block.nPoints : this.cellTupleCount(block);
        for (let v = 0; v < count; v++) {
            map[v] = v < tupleCount ? v : -1;
        }
        return map;
    }

    private cellTupleCount(block: DagmcBlockModel): number {
        const first = block.cellArrays[0];
        return first ? Math.floor(first.values.length / Math.max(1, first.components)) : 0;
    }

    /**
     * Instant recolor: rewrite vertex colors from the current color-by array
     * and colormap. No reload, no server restart.
     */
    private recolor(): void {
        if (!this.dataGroup) {
            return;
        }
        this.note = '';
        const selection = parseColorBy(this.colorBy);
        const solid = new THREE.Color(this.solidColor);
        this.dataGroup.children.forEach((group) => {
            const block = this.blocks.find((entry) => `block:${entry.blockIndex}` === group.name);
            if (!block) {
                return;
            }
            const array =
                selection && selection.kind !== 'solid' ? this.findArrayInBlock(block, selection.kind, selection.name) : undefined;
            if (selection && selection.kind !== 'solid' && !array) {
                this.note = `'${this.colorBy}' is not in every block — missing blocks show Solid Color`;
            }
            group.children.forEach((child) => {
                if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) {
                    return;
                }
                const geometry = child.geometry as THREE.BufferGeometry;
                const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
                const map = array ? this.tupleMap(block, geometry.userData['kind'] as DagmcRenderKind, array.association) : undefined;
                const [min, max] = array ? array.range : [0, 0];
                for (let i = 0; i < colors.count; i++) {
                    let r = solid.r;
                    let g = solid.g;
                    let b = solid.b;
                    if (array && map && map[i] >= 0) {
                        const value = tupleValue(array.values, array.components, map[i]);
                        if (Number.isFinite(value)) {
                            [r, g, b] = sampleNativeColormap(this.colormap, normalizeToUnit(value, min, max));
                        }
                    }
                    colors.setXYZ(i, r, g, b);
                }
                colors.needsUpdate = true;
            });
        });
    }

    /** Apply the viewer-core per-axis clip state to every block material. */
    private applyClip(): void {
        if (!this.dataGroup) {
            return;
        }
        const planes = this.toThreePlanes();
        this.dataGroup.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                (child.material as THREE.Material).clippingPlanes = planes;
            }
        });
    }

    private toThreePlanes(): THREE.Plane[] {
        const bounds = mergeDagmcBounds(this.visibleBlocks());
        if (!bounds) {
            return [];
        }
        return toThreePlaneParamsArray(this.clip, bounds).map(
            (params) => new THREE.Plane(new THREE.Vector3(...params.normal), params.constant)
        );
    }

    private syncMaterialProps(): void {
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        this.dataGroup?.traverse((child) => {
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
                const material = child.material as THREE.MeshLambertMaterial;
                material.wireframe = flags.wireframe;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
            }
        });
    }

    /** Toggle mesh/edge/point visibility for `wireframe`/`points` modes. */
    private applyShadingVisibility(): void {
        if (!this.dataGroup) {
            return;
        }
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        this.dataGroup.children.forEach((group) => {
            group.children.forEach((child) => {
                if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) {
                    return;
                }
                const geometry = child.geometry as THREE.BufferGeometry;
                const role = geometry.userData?.['role'];
                const kind = geometry.userData?.['kind'] as DagmcRenderKind | undefined;
                if (child instanceof THREE.Mesh) {
                    child.visible = !flags.pointsOnly;
                } else if (role === 'mesh-points') {
                    child.visible = flags.pointsOnly;
                } else if (kind === 'edges') {
                    // Edges back shaded/xray faces; wireframe and points modes
                    // have their own representation already.
                    child.visible = !flags.pointsOnly && !flags.wireframe;
                } else {
                    child.visible = true;
                }
            });
        });
    }

    private findArrayInBlock(block: DagmcBlockModel, kind: 'point' | 'cell', name: string): NativeVtkDataArray | undefined {
        const list = kind === 'point' ? block.pointArrays : block.cellArrays;
        return list.find((array) => array.name === name);
    }

    private findArray(kind: 'point' | 'cell', name: string): NativeVtkDataArray | undefined {
        for (const block of this.blocks) {
            const array = this.findArrayInBlock(block, kind, name);
            if (array) {
                return array;
            }
        }
        return undefined;
    }

    private hasArray(colorBy: string): boolean {
        const selection = parseColorBy(colorBy);
        return !selection || selection.kind === 'solid' || this.findArray(selection.kind, selection.name) !== undefined;
    }

    private describeBlocks(): string {
        if (this.blocks.length === 0) {
            return this.isLoading ? this.statusMessage : 'No volumes loaded';
        }
        const visible = this.visibleBlocks().length;
        const groups = this.modelInfo ? `, ${Object.keys(this.modelInfo.groups).length} groups` : '';
        const hint = this.modelInfo
            ? `${visible} of ${this.blocks.length} volumes (${Object.keys(this.modelInfo.materials).length} materials${groups})`
            : `${this.blocks.length} volumes (no model info)`;
        return `Multiblock — ${hint}`;
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
        if (this.blocks.length === 0) {
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
     * attached, the visible blocks are framed through the controls.
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
                console.warn('[DagmcViewer] Failed to load orbit controls:', error);
            });
    }
}
