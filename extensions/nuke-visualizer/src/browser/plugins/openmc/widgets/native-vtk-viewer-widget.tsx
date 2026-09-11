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
import { Tooltip, ViewBadge, ViewerNavBar, ViewCube } from 'nuke-essentials/lib/theme/browser/components';
import type { ViewerNavAction, ViewCubeHandle } from 'nuke-essentials/lib/theme/browser/components';
import {
    ClassifiedNativeVtkArrays,
    classifyNativeVtkArrays,
    colorByValue,
    DEFAULT_COLORMAP,
    defaultNativeColorBy,
    NativeVtkDataArray,
    NativeVtkModel,
    parseColorBy,
    parseNativeVtk,
    readVtkText,
    SOLID_COLOR,
    strideForBudget
} from './native-vtk/native-vtk-data';
import { COLORMAP_NAMES, getColormap, isColormapName, type ColormapName } from '../../../viewer-core/colormaps';
import {
    componentOptions,
    formatRangeValue,
    logScaleAvailable,
    MAGNITUDE_COMPONENT,
    mapScalar,
    mappingToCssGradient,
    resolveEffectiveRange,
    tupleScalar,
    type ColorRangeMode,
    type ScalarMapping
} from '../../../viewer-core/scalar-mapping';
import { LINE_WIDTH_SPEC, OPACITY_SPEC, POINT_SIZE_SPEC } from '../../../viewer-core/viewer-toolbar-model';
import {
    createOrbitControls,
    standardViewDirection,
    type BoundsCorner,
    type OrbitControlsHandle
} from '../../../viewer-core/orbit-controls';
import {
    addMeasurePoint,
    cancelMeasureStep,
    formatMeasureDistance,
    projectMeasurePoint,
    resetMeasureState,
    setMeasureActive,
    type MeasurePoint3D,
    type MeasureState
} from '../../../viewer-core/measure-model';
import { buildViewerContextMenuItems, isViewerContextMenuClick, openViewerContextMenu } from '../../../viewer-core/viewer-context-menu';
import {
    anyClipEnabled,
    boundingBoxFromPositions,
    ClipAxis,
    ClipPlanesState,
    createClipPlanesState,
    setAllClipEnabled,
    toThreePlaneParamsArray,
    updateAxisClip,
    type AxisClipState
} from '../../../viewer-core/clip-plane';
import {
    DEFAULT_VIEWER_SHADING_MODE,
    ViewerShadingMode,
    isViewerShadingMode,
    resolveViewerShadingFlags
} from '../../../viewer-core/shading-mode';
import { nextNavPopover, type ViewerNavPopoverKind } from '../../../viewer-core/viewer-nav-popover';
import { OpenMCVtkArrayInfo } from '../../../../common/openmc-protocol';
import {
    ViewerSettingsHost,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot,
    viewerSnapDirection
} from '../../../viewer-settings/viewer-settings-model';
import { ViewerMeasureLabel, type ViewerMeasureHandle } from './viewer-measure';
import {
    ViewerClipPopover,
    ViewerClipTrigger,
    ViewerFileActions,
    ViewerNavPopoverShell,
    ViewerShadingPopover,
    ViewerShadingTrigger
} from './viewer-nav-extras';
import './output-viewer.css';

/** Scratch view-projection matrix for the measure-label projection (module scope so the camera loop never allocates). */
const scratchViewProjection = new THREE.Matrix4();

/**
 * Props driving the native VTK viewer. Every field applies instantly to the
 * already-loaded dataset — changing color-by or the colormap never restarts
 * anything (there is no server to restart; this is the P1-B2 replacement for
 * the trame `--color-by` restart hack in `OpenMCOutputViewerWidget`).
 */
export interface NativeVtkViewerProps {
    /** `'Solid Color'`, `'Point: <name>'`, or `'Cell: <name>'` (base.serve format). */
    colorBy?: string;
    /** One of the ParaView-style colormaps in `COLORMAP_NAMES`. */
    colormap?: ColormapName;
    /** CSS color used in Solid Color mode. */
    solidColor?: string;
    /** Point sprite size in pixels. */
    pointSize?: number;
    /** Material opacity in [0, 1]. */
    opacity?: number;
    /** Line width in pixels (line and edge datasets). */
    lineWidth?: number;
    /** Canvas background CSS color; undefined follows the theme editor background. */
    background?: string;
    /** Scalar-bar (color legend) visibility. */
    scalarBarVisible?: boolean;
    /** Sample the colormap in reverse. */
    invert?: boolean;
    /** Log-scaled scalar mapping (applies only when the effective range is positive). */
    logScale?: boolean;
    /** Vector component to color by ({@link MAGNITUDE_COMPONENT} = L2 norm). */
    component?: number;
    /** Color-range mode: the data range or a custom user range. */
    rangeMode?: ColorRangeMode;
    /** Custom color range (used in `custom` mode). */
    customRange?: readonly [number, number];
    /** Shading mode (`shaded` | `edges` | `wireframe` | `points` | `xray`). */
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
export class NativeVtkViewerWidget extends ReactWidget implements ViewerSettingsHost {
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
    protected colormap: ColormapName = DEFAULT_COLORMAP;
    protected solidColor = '#d4d4d4';
    protected pointSize = 3;
    protected opacity = 1;
    protected lineWidth = 1;
    /** Canvas backdrop; undefined follows the theme editor background (the pre-scene.background look). */
    protected background: string | undefined;
    protected scalarBarVisible = true;
    protected invert = false;
    protected logScale = false;
    protected component = MAGNITUDE_COMPONENT;
    protected rangeMode: ColorRangeMode = 'auto';
    protected customRange: [number, number] | undefined;
    protected shading: ViewerShadingMode = DEFAULT_VIEWER_SHADING_MODE;
    protected clip: ClipPlanesState = createClipPlanesState();
    /** Active X/Y/Z tab of the header clip control (per-axis settings persist). */
    protected clipTab: ClipAxis = 'X';
    /**
     * Open bottom-bar popover (single slot, CAD `openPopover` parity — never
     * both cards). The widget owns the slot; every card control routes onto
     * the existing setters, so the sidebar stays authoritative.
     */
    protected openNavPopover: ViewerNavPopoverKind | undefined;
    /** Bar + card elements behind the outside-click dismissal (trigger clicks are inside the bar). */
    protected navBarElement: HTMLDivElement | null = null;
    protected navPopoverElement: HTMLDivElement | null = null;
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
    private gizmo: ViewCubeHandle | null = null;
    /** Viewport-only distance-measure session (never document state; cleared on rebuild). */
    private measure: MeasureState = { active: false, pending: undefined, segment: undefined };
    private measureGroup: THREE.Group | undefined;
    private measureLabel: ViewerMeasureHandle | null = null;
    /** World-size endpoint marker radius, derived from the dataset bounds at build time. */
    private measureMarkerSize = 0.01;
    private measureKeysAttached = false;

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
            lineWidth: this.lineWidth,
            background: this.background,
            scalarBarVisible: this.scalarBarVisible,
            invert: this.invert,
            logScale: this.logScale,
            component: this.component,
            rangeMode: this.rangeMode,
            customRange: this.customRange ? [this.customRange[0], this.customRange[1]] : undefined,
            shading: this.shading,
            clip: {
                X: { ...this.clip.X },
                Y: { ...this.clip.Y },
                Z: { ...this.clip.Z }
            }
        };
    }

    /** Apply viewer props; color-by/mapping/display fields take effect immediately. */
    applyProps(props: NativeVtkViewerProps): void {
        let colorsChanged = false;
        let displayChanged = false;
        let clipChanged = false;
        let chromeChanged = false;
        if (props.colorBy !== undefined && props.colorBy !== this.colorBy) {
            this.setColorBy(props.colorBy);
            colorsChanged = true;
        }
        if (props.colormap !== undefined && isColormapName(props.colormap) && props.colormap !== this.colormap) {
            this.colormap = props.colormap;
            colorsChanged = true;
        }
        if (props.component !== undefined && props.component !== this.component) {
            this.component = props.component;
            colorsChanged = true;
        }
        if (props.rangeMode !== undefined && props.rangeMode !== this.rangeMode) {
            this.rangeMode = props.rangeMode;
            colorsChanged = true;
        }
        if (
            props.customRange !== undefined &&
            (this.customRange === undefined || this.customRange[0] !== props.customRange[0] || this.customRange[1] !== props.customRange[1])
        ) {
            this.customRange = [props.customRange[0], props.customRange[1]];
            colorsChanged = true;
        }
        if (props.invert !== undefined && props.invert !== this.invert) {
            this.invert = props.invert;
            colorsChanged = true;
        }
        if (props.logScale !== undefined && props.logScale !== this.logScale) {
            this.logScale = props.logScale;
            colorsChanged = true;
        }
        if (props.solidColor !== undefined && props.solidColor !== this.solidColor) {
            this.solidColor = props.solidColor;
            colorsChanged = true;
        }
        if (props.opacity !== undefined && props.opacity !== this.opacity) {
            this.opacity = Math.min(1, Math.max(0, props.opacity));
            displayChanged = true;
        }
        if (props.pointSize !== undefined && props.pointSize > 0 && props.pointSize !== this.pointSize) {
            this.pointSize = props.pointSize;
            displayChanged = true;
        }
        if (props.lineWidth !== undefined && props.lineWidth > 0 && props.lineWidth !== this.lineWidth) {
            this.lineWidth = props.lineWidth;
            displayChanged = true;
        }
        if (props.background !== undefined && props.background !== this.background) {
            this.background = props.background;
            displayChanged = true;
        }
        if (props.scalarBarVisible !== undefined && props.scalarBarVisible !== this.scalarBarVisible) {
            this.scalarBarVisible = props.scalarBarVisible;
            chromeChanged = true;
        }
        if (props.shading !== undefined && isViewerShadingMode(props.shading) && props.shading !== this.shading) {
            this.shading = props.shading;
            displayChanged = true;
        }
        if (props.clip !== undefined) {
            this.clip = props.clip;
            clipChanged = true;
        }
        if (colorsChanged) {
            this.recolor();
        } else if (displayChanged) {
            this.applyDisplayProps();
        } else if (clipChanged) {
            this.applyClip();
            this.renderScene();
        }
        if (colorsChanged || displayChanged || clipChanged || chromeChanged) {
            this.update();
        }
    }

    /**
     * Switch the color-by array: a new array brings a new value domain, so the
     * mapping state resets (component, range, log scale). Invert is a
     * per-user preference and survives the switch.
     */
    private setColorBy(value: string): void {
        this.colorBy = value;
        this.component = MAGNITUDE_COMPONENT;
        this.rangeMode = 'auto';
        this.logScale = false;
    }

    // ------------------------------------------------------------------
    // Viewer Settings sidebar API (single-direction sync: the panel reads
    // the snapshot and applies edits through these setters — the same calls
    // the header used to make, never duplicated state)
    // ------------------------------------------------------------------

    /** Color-by entries for the sidebar select (same options the header offered). */
    colorByOptions(): { value: string; label: string }[] {
        if (!this.model || !this.classified) {
            return [{ value: SOLID_COLOR, label: SOLID_COLOR }];
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
        return options;
    }

    /** Whether the distance-measure tool is armed (sidebar toggle state). */
    isMeasureActive(): boolean {
        return this.measure.active;
    }

    /** Arm or disarm the distance-measure tool (sidebar toggle). */
    setMeasureActive(active: boolean): void {
        const next = setMeasureActive(this.measure, active);
        if (next !== this.measure) {
            this.measure = next;
            this.update();
        }
    }

    /** Snap the camera to an orbit-handle direction (sidebar snap group). */
    snapViewerTo(direction: BoundsCorner): void {
        this.orbitControls?.setViewDirection(direction);
    }

    /** Read the current settings for the sidebar panel. */
    getViewerSettingsSnapshot(): ViewerSettingsSnapshot {
        const solid = this.colorBy === SOLID_COLOR;
        const selection = parseColorBy(this.colorBy);
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        const effectiveRange = array ? resolveEffectiveRange(this.rangeMode, array.range, this.customRange) : undefined;
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: this.model !== undefined,
            colorBy: { value: this.colorBy, options: this.colorByOptions() },
            colormap: {
                value: this.colormap,
                options: [...COLORMAP_NAMES],
                disabled: solid,
                invert: this.invert,
                logScale: { value: this.logScale, disabled: !effectiveRange || !logScaleAvailable(effectiveRange) }
            },
            ...(array && array.components > 1
                ? { component: { value: this.component, options: [...componentOptions(array.components)] } }
                : {}),
            ...(array && effectiveRange
                ? {
                      range: {
                          mode: this.rangeMode,
                          min: effectiveRange[0],
                          max: effectiveRange[1],
                          dataMin: array.range[0],
                          dataMax: array.range[1]
                      }
                  }
                : {}),
            scalarBar: { visible: this.scalarBarVisible },
            ...(solid ? { solidColor: { value: this.solidColor } } : {}),
            background: { value: this.resolveBackground() },
            shading: { value: this.shading },
            clip: { state: this.clip, tab: this.clipTab },
            measure: { active: this.measure.active },
            opacity: { value: this.opacity, ...OPACITY_SPEC },
            pointSize: { value: this.pointSize, ...POINT_SIZE_SPEC },
            lineWidth: { value: this.lineWidth, ...LINE_WIDTH_SPEC }
        };
    }

    /** Apply a sidebar edit through the existing prop setters. */
    applyViewerSettings(patch: ViewerSettingsPatch): void {
        if (patch.clipTab !== undefined && patch.clipTab !== this.clipTab) {
            this.clipTab = patch.clipTab;
            this.update();
        }
        if (patch.measureActive !== undefined) {
            this.setMeasureActive(patch.measureActive);
        }
        if (patch.snap !== undefined) {
            this.snapViewerTo(viewerSnapDirection(patch.snap));
        }
        let nextRangeMode: ColorRangeMode | undefined;
        let nextCustomRange: [number, number] | undefined;
        if (patch.range !== undefined) {
            if (patch.range === 'auto') {
                nextRangeMode = 'auto';
            } else {
                nextRangeMode = 'custom';
                nextCustomRange = [patch.range[0], patch.range[1]];
            }
        }
        this.applyProps({
            colorBy: patch.colorBy,
            colormap: patch.colormap as ColormapName | undefined,
            component: patch.component,
            rangeMode: nextRangeMode,
            customRange: nextCustomRange,
            invert: patch.invert,
            logScale: patch.logScale,
            scalarBarVisible: patch.scalarBarVisible,
            solidColor: patch.solidColor,
            background: patch.background,
            opacity: patch.opacity,
            pointSize: patch.pointSize,
            lineWidth: patch.lineWidth,
            shading: patch.shading,
            clip: patch.clip
        });
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
                this.setColorBy(fallback ?? SOLID_COLOR);
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

    /**
     * Optional header strip. The base viewer keeps no header at all —
     * screenshot/reload ride the nav bar ({@link renderNavCluster}) and the
     * file name lives exactly once in the canvas `ViewBadge`. Subclasses with
     * real header content (tally kind chip, random-ray quick-select) override
     * this. Display settings live in the Viewer Settings sidebar, which
     * drives this widget through `applyViewerSettings`.
     */
    protected renderHeader(): React.ReactNode {
        return undefined;
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
                    <div className="openmc-output-viewer-hint nuke-viewer-status-line">
                        {this.describeModel()}
                        {this.note ? ` — ${this.note}` : ''} Drag to orbit, wheel to zoom, right-drag to pan.
                        {this.measure.active ? ' Measure mode: click two surface points; Escape cancels.' : ''}
                    </div>
                    <div style={{ flex: '1', minHeight: '0', position: 'relative', display: 'flex' }}>
                        <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                        {this.renderViewBadge()}
                        {this.renderNavCluster()}
                        {this.renderGizmo()}
                        {this.renderMeasureLabel()}
                    </div>
                    {this.renderLegend()}
                </div>
            </>
        );
    }

    /**
     * Shared viewer bottom bar over the 3D viewarea, driving the orbit
     * handle. Clip/shading quick-access popovers ride as `children` (the
     * same extension point CAD extras use): the triggers open anchored
     * cards whose controls call the existing prop setters — stateless
     * mirrors of the sidebar, never new state.
     *
     * The one-click X-plane section button is folded into the Clip card
     * (per-axis enable covers it); Exclude/Isolate stay DAGMC-only direct
     * buttons (transient canvas selection, no CAD popover analog).
     */
    protected renderNavCluster(): React.ReactNode {
        const disabled = this.isLoading || !this.model;
        return (
            <>
                <ViewerNavBar
                    ref={(element) => {
                        this.navBarElement = element;
                    }}
                    disabled={disabled}
                    onAction={(action) => this.handleNavAction(action)}
                >
                    <ViewerClipTrigger
                        clipEnabled={anyClipEnabled(this.clip)}
                        open={this.openNavPopover === 'clip'}
                        disabled={disabled}
                        onToggle={() => this.toggleNavPopover('clip')}
                    />
                    <ViewerShadingTrigger
                        shading={this.shading}
                        open={this.openNavPopover === 'shading'}
                        disabled={disabled}
                        onToggle={() => this.toggleNavPopover('shading')}
                    />
                    <ViewerFileActions
                        disabled={disabled}
                        onScreenshot={() => this.saveScreenshot()}
                        onReload={() => this.fileUri && this.setVtkFile(this.fileUri)}
                    />
                </ViewerNavBar>
                {this.openNavPopover === 'clip' && (
                    <ViewerNavPopoverShell
                        popoverRef={(element) => {
                            this.navPopoverElement = element;
                        }}
                    >
                        <ViewerClipPopover
                            clip={this.clip}
                            tab={this.clipTab}
                            disabled={disabled}
                            onTabChange={(axis) => this.setClipTab(axis)}
                            onAxisChange={(axis, patch) => this.updateClipAxis(axis, patch)}
                        />
                    </ViewerNavPopoverShell>
                )}
                {this.openNavPopover === 'shading' && (
                    <ViewerNavPopoverShell
                        popoverRef={(element) => {
                            this.navPopoverElement = element;
                        }}
                    >
                        <ViewerShadingPopover
                            shading={this.shading}
                            disabled={disabled}
                            onSelect={(mode) => this.selectShadingMode(mode)}
                        />
                    </ViewerNavPopoverShell>
                )}
            </>
        );
    }

    /** Toggle the open popover slot (re-click closes, the other trigger switches). */
    private toggleNavPopover(kind: ViewerNavPopoverKind): void {
        this.openNavPopover = nextNavPopover(this.openNavPopover, kind);
        this.update();
    }

    /** Close the open popover card (Escape / outside-click dismissal). */
    private closeNavPopover(): void {
        if (this.openNavPopover !== undefined) {
            this.openNavPopover = undefined;
            this.update();
        }
    }

    /** Clip-card axis tab through the widget-owned tab (the sidebar shows the same tab). */
    private setClipTab(tab: ClipAxis): void {
        if (tab !== this.clipTab) {
            this.clipTab = tab;
            this.update();
        }
    }

    /** Clip-card axis edit through the existing clip prop (sidebar stays authoritative). */
    private updateClipAxis(axis: ClipAxis, patch: Partial<AxisClipState>): void {
        this.applyProps({ clip: updateAxisClip(this.clip, axis, patch) });
    }

    /** Shading-card pick through the existing shading prop (closes the card, CAD parity). */
    private selectShadingMode(mode: ViewerShadingMode): void {
        this.applyProps({ shading: mode });
        this.closeNavPopover();
    }

    /** Dataset badge over the 3D viewarea (hidden until a dataset loads). */
    protected renderViewBadge(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        return <ViewBadge text={this.fileUri?.path.base ?? 'VTK dataset'} />;
    }

    /** Shared orientation cube over the 3D viewarea (hidden until a dataset loads). */
    protected renderGizmo(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        return (
            <ViewCube
                ref={(handle) => {
                    this.gizmo = handle;
                }}
                onSnap={(direction) => this.orbitControls?.setViewDirection(direction)}
            />
        );
    }

    /** Distance-measure label over the 3D viewarea (hidden until a dataset loads; positioned imperatively). */
    protected renderMeasureLabel(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        return (
            <ViewerMeasureLabel
                ref={(handle) => {
                    this.measureLabel = handle;
                }}
            />
        );
    }

    /** Raycast-pick threshold from the dataset bounds (points/lines need a world-size tolerance). */
    private measurePickTolerance(): number {
        const bounds = this.model ? boundingBoxFromPositions(this.model.positions) : undefined;
        if (!bounds) {
            return this.measureMarkerSize;
        }
        const dx = bounds.max[0] - bounds.min[0];
        const dy = bounds.max[1] - bounds.min[1];
        const dz = bounds.max[2] - bounds.min[2];
        return Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.01, 1e-9);
    }

    /** Canvas click while the measure tool is active: raycast the data meshes and record the surface point. */
    private onMeasureClick = (event: MouseEvent): void => {
        if (!this.measure.active || event.button !== 0) {
            return;
        }
        const canvas = this.renderer?.domElement;
        const camera = this.camera;
        const dataGroup = this.dataGroup;
        if (!canvas || !camera || !dataGroup) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }
        const ndc = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.params.Points.threshold = this.measurePickTolerance();
        raycaster.params.Line.threshold = this.measurePickTolerance();
        raycaster.setFromCamera(ndc, camera);
        // Data meshes only (never the measure overlay itself): a miss leaves
        // the session untouched so stray clicks cannot commit bogus pairs.
        const hit = raycaster.intersectObjects(dataGroup.children, true)[0];
        if (!hit) {
            return;
        }
        const point: MeasurePoint3D = [hit.point.x, hit.point.y, hit.point.z];
        const next = addMeasurePoint(this.measure, point);
        if (next !== this.measure) {
            this.measure = next;
            this.syncMeasureScene();
            this.update();
        }
    };

    /**
     * Outside-click dismissal for the nav popover (CAD canvas-click parity,
     * generalized): a pointer-down outside both the bottom bar (triggers
     * live there, so re-clicks toggle instead of closing first) and the
     * open card closes it. Window capture phase so canvas drags dismiss
     * immediately; propagation continues so orbit/measure still work.
     */
    private onWindowPointerDown = (event: PointerEvent): void => {
        if (this.openNavPopover === undefined) {
            return;
        }
        if (!(event.target instanceof Node)) {
            return;
        }
        if (this.navBarElement?.contains(event.target) === true || this.navPopoverElement?.contains(event.target) === true) {
            return;
        }
        this.closeNavPopover();
    };

    /**
     * Escape while focus is inside this widget: close the open nav popover
     * first (CAD parity — the card never steals canvas shortcuts; focus is
     * never moved into it), else cancel the measure step. Window capture
     * phase (like nuke-cad's viewport keys) so Theia's own Escape bindings
     * do not swallow it; propagation stops only when something was actually
     * dismissed.
     */
    private onWindowKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') {
            return;
        }
        if (!(event.target instanceof Node) || !this.node.contains(event.target)) {
            return;
        }
        if (this.openNavPopover !== undefined) {
            this.closeNavPopover();
            event.stopPropagation();
            event.preventDefault();
            return;
        }
        const next = cancelMeasureStep(this.measure);
        if (next !== this.measure) {
            this.measure = next;
            this.syncMeasureScene();
            this.update();
            event.stopPropagation();
            event.preventDefault();
        }
    };

    /** Lazily create the world-anchored measure overlay group (line + endpoint spheres live outside the data group). */
    private ensureMeasureGroup(): THREE.Group | undefined {
        if (!this.scene) {
            return undefined;
        }
        if (!this.measureGroup) {
            this.measureGroup = new THREE.Group();
            this.measureGroup.name = 'measure-overlay';
            this.scene.add(this.measureGroup);
        }
        return this.measureGroup;
    }

    /** Dispose every measure overlay object (geometries + materials). */
    private clearMeasureSceneObjects(): void {
        const group = this.measureGroup;
        if (!group) {
            return;
        }
        while (group.children.length > 0) {
            const child = group.children.pop();
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry.dispose();
                (child.material as THREE.Material).dispose();
            }
        }
    }

    /** Rebuild the 3D annotation from the session: pending sphere, or segment line + two spheres. */
    private syncMeasureScene(): void {
        const group = this.ensureMeasureGroup();
        if (!group) {
            return;
        }
        this.clearMeasureSceneObjects();
        const color = 0xe8a400;
        const addSphere = (point: MeasurePoint3D): void => {
            const geometry = new THREE.SphereGeometry(this.measureMarkerSize, 16, 12);
            const material = new THREE.MeshBasicMaterial({ color });
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.set(point[0], point[1], point[2]);
            group.add(sphere);
        };
        const segment = this.measure.segment;
        if (segment) {
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(segment.a[0], segment.a[1], segment.a[2]),
                new THREE.Vector3(segment.b[0], segment.b[1], segment.b[2])
            ]);
            group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color })));
            addSphere(segment.a);
            addSphere(segment.b);
        } else if (this.measure.pending) {
            addSphere(this.measure.pending);
        }
        this.renderScene();
    }

    /** Re-project the measure label for the current camera (direct DOM writes, never React state). */
    private updateMeasureLabel(): void {
        const label = this.measureLabel;
        const camera = this.camera;
        const host = this.host;
        if (!label || !camera || !host) {
            return;
        }
        const segment = this.measure.segment;
        if (!segment || !this.model) {
            label.setLabel(0, 0, '', false);
            return;
        }
        camera.updateMatrixWorld();
        // Scratch matrix (never allocated per frame): the camera loop must
        // not churn the GC on large-model orbits.
        scratchViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const projected = projectMeasurePoint(segment.midpoint, scratchViewProjection.elements, host.clientWidth, host.clientHeight);
        label.setLabel(projected.x, projected.y, formatMeasureDistance(segment.distance), projected.visible);
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
        if (!this.scalarBarVisible) {
            return undefined;
        }
        const selection = parseColorBy(this.colorBy);
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        if (!array) {
            return undefined;
        }
        const mapping = this.scalarMappingFor(array);
        if (!mapping) {
            return undefined;
        }
        return (
            <Tooltip content={`${array.name} range`} position="top">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' }}>
                    <span style={{ fontSize: '11px' }}>{formatRangeValue(mapping.range[0])}</span>
                    <div style={{ flex: '1', height: '10px', background: mappingToCssGradient(mapping) }} />
                    <span style={{ fontSize: '11px' }}>{formatRangeValue(mapping.range[1])}</span>
                    <span style={{ fontSize: '11px', opacity: 0.7 }}>{array.name}</span>
                </div>
            </Tooltip>
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
        if (!this.measureKeysAttached) {
            window.addEventListener('keydown', this.onWindowKeyDown, true);
            window.addEventListener('pointerdown', this.onWindowPointerDown, true);
            this.measureKeysAttached = true;
        }
    }

    protected onBeforeDetach(msg: Message): void {
        if (this.measureKeysAttached) {
            window.removeEventListener('keydown', this.onWindowKeyDown, true);
            window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
            this.measureKeysAttached = false;
        }
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
        // Focusable canvas: a click focuses it, so the window-capture Escape
        // handler (measure cancel / popover dismiss) sees key events targeted
        // inside this widget — plain canvas clicks otherwise leave focus on
        // <body> and Escape dead-ends.
        this.renderer.domElement.tabIndex = 0;
        this.renderer.domElement.addEventListener('pointerdown', () => this.renderer?.domElement.focus());
        this.renderer.localClippingEnabled = true;
        this.host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.resolveBackground());
        // Lit scene (same intensities as the DAGMC viewer): Lambert surfaces
        // shade with depth instead of rendering flat gray.
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(1, 2, 3);
        this.scene.add(directional);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.attachOrbitControls();
        this.attachContextMenu(this.renderer.domElement);
        this.renderer.domElement.addEventListener('click', this.onMeasureClick);
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
        this.measureGroup = undefined;
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
        this.updateMeasureLabel();
    }

    /** Re-project the cube axes for the current camera (direct DOM writes, never React state). */
    private updateGizmo(): void {
        const gizmo = this.gizmo;
        const camera = this.camera;
        if (!gizmo || !camera || !this.model) {
            return;
        }
        const quaternion = camera.quaternion;
        gizmo.update({ quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
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
        // Rebuild clears the measure session (viewport state, never document
        // state); the label hides on the next repaint via updateMeasureLabel.
        this.measure = resetMeasureState();
        this.clearMeasureSceneObjects();
        this.measureMarkerSize = this.measurePickTolerance();
        this.dataGroup = new THREE.Group();
        if (model.triangles && model.triangles.length > 0) {
            // Surface datasets render filled triangles (lit, DoubleSide for
            // open shells); outlines/points come from the shading mode.
            const positions = this.triangleVertexPositions(model);
            const mesh = this.buildTriangleMesh(positions);
            this.dataGroup.add(mesh);
            this.dataGroup.add(this.buildEdgeOverlay(mesh.geometry));
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

    /** Dark edge overlay for `edges` shading (ParaView Surface With Edges), derived from the mesh geometry. */
    private buildEdgeOverlay(meshGeometry: THREE.BufferGeometry): THREE.LineSegments {
        const geometry = new THREE.EdgesGeometry(meshGeometry);
        geometry.userData = { role: 'edges' };
        const material = new THREE.LineBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: this.opacity });
        const lines = new THREE.LineSegments(geometry, material);
        lines.visible = this.shading === 'edges';
        return lines;
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
     * Build the effective scalar mapping for one array (shared by recolor and
     * the legend): colormap definition, effective range (auto data range or
     * the custom user range), log scale (only when strictly positive),
     * invert, and component.
     */
    private scalarMappingFor(array: NativeVtkDataArray): ScalarMapping | undefined {
        const definition = getColormap(this.colormap) ?? getColormap(DEFAULT_COLORMAP);
        if (!definition) {
            return undefined;
        }
        const range = resolveEffectiveRange(this.rangeMode, array.range, this.customRange);
        return {
            definition,
            range,
            logScale: this.logScale && logScaleAvailable(range),
            invert: this.invert,
            component: this.component
        };
    }

    /**
     * Instant recolor: rewrite vertex colors from the current color-by array
     * and scalar mapping. No reload, no server restart — the random-ray
     * restart hack is structurally impossible on this path.
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
            // Box3Helper (grid bounds) and the edges overlay carry no color attribute — leave them.
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
        const paintAllSolid = (): void => {
            const solidAt = (): [number, number, number] => [solid.r, solid.g, solid.b];
            this.dataGroup?.children.forEach((child) => {
                if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                    paint(child.geometry, solidAt);
                }
            });
        };
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        if (!array) {
            if (selection && selection.kind !== 'solid') {
                this.note = `'${this.colorBy}' is not in this file — showing Solid Color`;
            }
            paintAllSolid();
            this.refreshView();
            return;
        }
        const mapping = this.scalarMappingFor(array);
        if (!mapping) {
            paintAllSolid();
            this.refreshView();
            return;
        }
        // Non-finite values (no preset nanColor) paint the solid color, matching the pre-LUT behavior.
        const mapAt = (value: number): [number, number, number] => {
            const mapped = mapScalar(value, mapping);
            return mapped ? [mapped[0], mapped[1], mapped[2]] : [solid.r, solid.g, solid.b];
        };
        this.dataGroup.children.forEach((child) => {
            if (child instanceof THREE.LineSegments) {
                const segments = model.segments ?? new Uint32Array(0);
                const tupleOfVertex = this.lineTupleIndex(model, array, segments);
                paint(child.geometry, (vertex) =>
                    mapAt(tupleScalar(array.values, array.components, tupleOfVertex(vertex), mapping.component))
                );
            } else if (child instanceof THREE.Mesh) {
                const triangles = model.triangles ?? new Uint32Array(0);
                const tupleOfVertex = this.meshTupleIndex(model, array, triangles);
                paint(child.geometry, (vertex) =>
                    mapAt(tupleScalar(array.values, array.components, tupleOfVertex(vertex), mapping.component))
                );
            } else if (child instanceof THREE.Points) {
                const role = child.geometry.userData?.['role'];
                if (role === 'mesh-points' && model.triangles) {
                    const tupleOfVertex = this.meshTupleIndex(model, array, model.triangles);
                    paint(child.geometry, (vertex) =>
                        mapAt(tupleScalar(array.values, array.components, tupleOfVertex(vertex), mapping.component))
                    );
                } else if (role === 'line-points' && model.segments) {
                    const segments = model.segments;
                    const tupleOfVertex = this.lineTupleIndex(model, array, segments);
                    paint(child.geometry, (vertex) =>
                        mapAt(tupleScalar(array.values, array.components, tupleOfVertex(vertex), mapping.component))
                    );
                } else {
                    const tupleOfVertex = this.pointTupleIndex(model, array);
                    paint(child.geometry, (vertex) =>
                        mapAt(tupleScalar(array.values, array.components, tupleOfVertex(vertex), mapping.component))
                    );
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
                material.needsUpdate = true;
            } else if (child instanceof THREE.LineSegments) {
                const material = child.material as THREE.LineBasicMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
                material.linewidth = this.lineWidth;
                material.needsUpdate = true;
            } else if (child instanceof THREE.Mesh) {
                // Lambert supports wireframe/opacity/depthWrite; emissive stays untouched.
                const material = child.material as THREE.MeshLambertMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
                material.wireframe = flags.wireframe;
                material.needsUpdate = true;
            }
        });
    }

    /** Effective canvas backdrop: the setting, else the theme editor background (the look before scene.background). */
    private resolveBackground(): string {
        if (this.background !== undefined) {
            return this.background;
        }
        const themed = getComputedStyle(document.documentElement).getPropertyValue('--theia-editor-background').trim();
        return themed.length > 0 ? themed : '#1a1a26';
    }

    /** Light display-only refresh: background/material props/visibility/clip, no vertex repaint. */
    private applyDisplayProps(): void {
        if (this.scene) {
            this.scene.background = new THREE.Color(this.resolveBackground());
        }
        this.syncMaterialProps();
        this.applyShadingVisibility();
        this.applyClip();
        this.renderScene();
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
                const role = child.geometry.userData?.['role'];
                child.visible = role === 'edges' ? this.shading === 'edges' && !flags.pointsOnly : !flags.pointsOnly;
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

    /** View-action menu: fit, screenshot, clip toggle, per-mode shading. */
    private openContextMenu(clientX: number, clientY: number): void {
        if (!this.model) {
            return;
        }
        this.contextMenuClose?.();
        this.contextMenuClose = openViewerContextMenu(
            { x: clientX, y: clientY },
            buildViewerContextMenuItems({ shading: this.shading, clipChecked: anyClipEnabled(this.clip) }),
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
        } else if (id.startsWith('shading:')) {
            const mode = id.slice('shading:'.length);
            if (isViewerShadingMode(mode)) {
                this.applyProps({ shading: mode });
            }
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
