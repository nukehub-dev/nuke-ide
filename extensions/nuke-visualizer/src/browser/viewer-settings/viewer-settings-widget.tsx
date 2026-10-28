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
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ApplicationShell, Widget } from '@theia/core/lib/browser';
import { Message } from '@theia/core/lib/browser';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { ColorPicker, NukeSelect, NukeSlider, NukeSwitch, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { NativeVtkViewerWidget } from '../plugins/openmc/widgets/native-vtk-viewer-widget';
import { DagmcViewerWidget } from '../plugins/openmc/widgets/dagmc/dagmc-viewer-widget';
import { GeometryNativeViewerWidget } from '../plugins/openmc/widgets/geometry-native/geometry-native-viewer-widget';
import { ExodusTimeSliderWidget } from '../plugins/openmc/widgets/exodus-series/exodus-time-slider-widget';
import { anyClipEnabled, CLIP_AXES, setAllClipEnabled, updateAxisClip } from '../viewer-core/clip-plane';
import { formatRangeValue } from '../viewer-core/scalar-mapping';
import { isViewerShadingMode, VIEWER_SHADING_MODES } from '../viewer-core/shading-mode';
import { isWarpScaleMode, WARP_EXAGGERATION_SPEC, WARP_SCALE_MODES } from '../viewer-core/warp-vectors';
import { DEFAULT_GLYPH_DENSITY, DEFAULT_GLYPH_SCALE, GLYPH_DENSITY_SPEC, GLYPH_SCALE_SPEC } from '../viewer-core/glyph-layout';
import { SLICE_AXES } from '../viewer-core/slice-view';
import { DEFAULT_OPACITY_STOPS, MAX_OPACITY_STOPS, type OpacityStop } from '../viewer-core/volume-transfer';
import { SlicePreview } from './slice-preview';
import { parseViewerState, serializeViewerState } from '../viewer-core/viewer-state';
import { UncertaintyEditor } from './uncertainty-editor';
import {
    RANGE_SLIDER_STEPS,
    rangeSliderToValue,
    rangeValueToSlider,
    resolveViewerSettingsTargetId,
    VIEWER_SNAP_ACTIONS,
    ViewerSettingsHost,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot
} from './viewer-settings-model';
import './viewer-settings.css';

/**
 * Viewer Settings sidebar panel: display settings for the active native 3D
 * viewer (color-by array/component, colormap, range, legend, warp-by-vector,
 * solid color, background, shading, point/line size, opacity, clip, measure,
 * comparison, axis snaps) in one Theia/React view, following the Model Outline active-widget pattern.
 *
 * The panel binds once — every native viewer (native-VTK and its tally /
 * output subclasses, DAGMC, geometry-native, Exodus) exposes the same
 * {@link ViewerSettingsHost} surface — and holds no viewer state itself:
 * every render reads a fresh snapshot from the bound widget, and every
 * edit routes through the widget's existing setters. The binding follows
 * the last-active viewer tab and stays put while the panel itself has
 * focus (clicking a control must not unbind the viewer); closing the tab
 * drops back to the empty state. Widget-side changes (context-menu
 * shading cycle, programmatic color-by) appear on the next shell
 * activation/change event, which re-renders the panel.
 *
 * Chrome follows the CAD Feature Tree / Model Outline panels (icon +
 * subtitle header, collapsible count-badge sections, per-row icons, live
 * status dots, Nuke tooltips throughout, never `title=`). Section collapse
 * is panel-local UI state only — it never touches the viewer contract.
 * Scalar-only rows (colormap, Invert/Log, range, threshold, color legend)
 * are omitted while the snapshot reports no scalar mapping
 * (`colormap.disabled`: Solid Color or a DAGMC categorical mode), leaving
 * the Color by row plus the snapshot note.
 */
@injectable()
export class ViewerSettingsWidget extends ReactWidget {
    static readonly ID = 'nuke-visualizer-viewer-settings-widget';
    static readonly LABEL = 'Viewer Settings';

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;

    protected activeViewer: Widget | undefined;
    /** Panel-local collapsed sections (CAD TreeSection pattern); viewer state is never cached here. */
    protected collapsedSections = new Set<string>();

    constructor(options?: any) {
        super(options);
        // Sidebar panels scroll natively (see the panel CSS) — no PerfectScrollbar thumb overlay.
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = ViewerSettingsWidget.ID;
        this.title.label = ViewerSettingsWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = codicon('settings-gear');
        this.toDispose.push(this.shell.onDidChangeActiveWidget(() => this.refreshActiveViewer()));
        this.toDispose.push(this.shell.onDidChangeCurrentWidget(() => this.refreshActiveViewer()));
        this.refreshActiveViewer();
    }

    /**
     * Force a fresh snapshot read. Commands that mutate viewer state without
     * a shell activation (comparison join/leave) call this after their edit.
     */
    refresh(): void {
        this.refreshActiveViewer();
    }

    /**
     * Rebind to the active viewer tab (active wins, otherwise current,
     * otherwise the main area's current tab — the panel itself holds active
     * and current right after opening). The binding is sticky: shell events
     * fired by interacting with this panel must not unbind the tab being
     * adjusted — only another viewer tab switches the binding, and a
     * disposed (closed) tab drops it.
     */
    protected refreshActiveViewer(): void {
        const active = this.shell.activeWidget;
        const current = this.shell.currentWidget;
        const main = this.shell.getCurrentWidget('main');
        const targetId = resolveViewerSettingsTargetId(active?.id, current?.id, main?.id);
        if (targetId !== undefined) {
            const next = [active, current, main].find((candidate) => candidate?.id === targetId);
            if (next !== undefined && next !== this.activeViewer) {
                this.activeViewer = next;
            }
        } else if (this.activeViewer?.isDisposed) {
            this.activeViewer = undefined;
        }
        this.update();
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.refreshActiveViewer();
    }

    /** The bound viewer when the bound tab is a live viewer (a single binding site, not per viewer). */
    protected settingsHost(): ViewerSettingsHost | undefined {
        const viewer = this.activeViewer;
        if (!viewer || viewer.isDisposed) {
            return undefined;
        }
        if (
            viewer instanceof NativeVtkViewerWidget ||
            viewer instanceof DagmcViewerWidget ||
            viewer instanceof GeometryNativeViewerWidget ||
            viewer instanceof ExodusTimeSliderWidget
        ) {
            return viewer;
        }
        return undefined;
    }

    /** Apply a sidebar edit through the widget's setters, then re-render from the live snapshot. */
    protected applyPatch(host: ViewerSettingsHost, patch: ViewerSettingsPatch): void {
        host.applyViewerSettings(patch);
        this.update();
    }

    /** Saved viewer-state map (tab id -> serialized JSON). */
    protected viewerStateMap(): Record<string, string> {
        const value = this.preferences.get('nukeVisualizer.viewerStates');
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
    }

    protected async saveViewerState(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): Promise<void> {
        const state = host.getViewerState?.();
        if (!state) {
            return;
        }
        await this.preferences.set('nukeVisualizer.viewerStates', {
            ...this.viewerStateMap(),
            [snapshot.widgetId]: serializeViewerState(state)
        });
        this.update();
    }

    protected restoreViewerState(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): void {
        const serialized = this.viewerStateMap()[snapshot.widgetId];
        const state = serialized ? parseViewerState(serialized) : undefined;
        if (state) {
            host.applyViewerState?.(state);
        }
        this.update();
    }

    protected toggleSection(id: string): void {
        if (this.collapsedSections.has(id)) {
            this.collapsedSections.delete(id);
        } else {
            this.collapsedSections.add(id);
        }
        this.update();
    }

    /**
     * CAD-style panel header: fixed panel name with an accent icon plus the
     * bound viewer tab label as an ellipsis-truncated subtitle (full text in
     * the Nuke tooltip, never overflowing raw text, never `title=`).
     */
    protected renderHeader(subtitle: string | undefined, subtitleTooltip: string): React.ReactNode {
        return (
            <div className="viewer-settings-header">
                <i className={`${codicon('settings-gear')} viewer-settings-header-icon`}></i>
                <div className="viewer-settings-header-text">
                    <span className="viewer-settings-header-name">Viewer Settings</span>
                    {subtitle !== undefined ? (
                        <Tooltip content={subtitleTooltip} position="bottom">
                            <span className="viewer-settings-title">{subtitle}</span>
                        </Tooltip>
                    ) : (
                        <span className="viewer-settings-title viewer-settings-title-empty">No viewer open</span>
                    )}
                </div>
            </div>
        );
    }

    /**
     * CAD-style collapsible section: chevron + icon + uppercase label +
     * integer count badge, with an optional live status dot (clip planes
     * active, measure armed). Collapse is panel-local; the body keeps every
     * existing control hook unchanged.
     */
    protected renderSection(
        id: string,
        label: string,
        icon: string,
        count: number,
        dotOn: boolean | undefined,
        body: React.ReactNode
    ): React.ReactNode {
        const collapsed = this.collapsedSections.has(id);
        return (
            <div className={`viewer-settings-section${collapsed ? ' collapsed' : ''}`}>
                <div
                    className="viewer-settings-category-header"
                    role="button"
                    tabIndex={0}
                    onClick={() => this.toggleSection(id)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            this.toggleSection(id);
                        }
                    }}
                >
                    <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`}></i>
                    <i className={`codicon codicon-${icon} viewer-settings-section-icon`}></i>
                    <span>{label}</span>
                    <span className="viewer-settings-count-badge">{count}</span>
                    {dotOn !== undefined && <span className={`viewer-settings-state-dot${dotOn ? ' is-on' : ''}`}></span>}
                </div>
                {!collapsed && <div className="viewer-settings-section-body">{body}</div>}
            </div>
        );
    }

    protected renderRowLabel(icon: string, text: string, tooltip: string): React.ReactNode {
        return (
            <Tooltip content={tooltip} position="right">
                <span className="viewer-settings-row-label">
                    <i className={`codicon codicon-${icon} viewer-settings-row-icon`}></i>
                    {text}
                </span>
            </Tooltip>
        );
    }

    protected render(): React.ReactNode {
        const host = this.settingsHost();
        const snapshot = host?.getViewerSettingsSnapshot();
        if (!host || !snapshot) {
            return (
                <div className="viewer-settings-panel">
                    {this.renderHeader(undefined, '')}
                    <div className="viewer-settings-empty">
                        <i className={codicon('settings-gear')}></i>
                        <p>No viewer open.</p>
                        <span className="empty-hint">
                            Open a VTK, DAGMC, tally, geometry, or Exodus file to adjust its display settings here.
                        </span>
                    </div>
                </div>
            );
        }
        return (
            <div className="viewer-settings-panel">
                {this.renderHeader(snapshot.title, snapshot.widgetId)}
                {snapshot.hasDataset && snapshot.note !== undefined && (
                    <div className="viewer-settings-note nuke-viewer-status-line">{snapshot.note}</div>
                )}
                {!snapshot.hasDataset ? (
                    <div className="viewer-settings-empty">
                        <p>No dataset loaded yet.</p>
                        <span className="empty-hint">Settings appear here once the viewer finishes loading its file.</span>
                    </div>
                ) : (
                    host && (
                        <>
                            {this.renderDisplaySection(host, snapshot)}
                            {this.renderUncertaintySection(host, snapshot)}
                            {this.renderVolumeSection(host, snapshot)}
                            {this.renderSliceSection(host, snapshot)}
                            {this.renderClipSection(host, snapshot)}
                            {this.renderStepSection(host, snapshot)}
                            {this.renderMeasureSection(host, snapshot)}
                            {this.renderComparisonSection(host, snapshot)}
                            {this.renderViewSection(host, snapshot)}
                        </>
                    )
                )}
            </div>
        );
    }

    protected renderDisplaySection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        // One rule for every viewer: a disabled colormap means no scalar array
        // is active (Solid Color or DAGMC Material/Volume/Group), so the
        // mapping controls are omitted instead of shown as dead widgets.
        const scalarMapping = snapshot.colormap !== undefined && !snapshot.colormap.disabled;
        const rows = [
            snapshot.colorBy && this.renderColorBy(host, snapshot),
            scalarMapping && snapshot.component && this.renderComponent(host, snapshot),
            scalarMapping && snapshot.colormap && this.renderColormap(host, snapshot),
            scalarMapping && snapshot.range && this.renderRange(host, snapshot),
            scalarMapping && snapshot.threshold && this.renderThreshold(host, snapshot),
            scalarMapping && snapshot.scalarBar && this.renderScalarBar(host, snapshot),
            snapshot.tallyVolume && this.renderTallyVolume(host, snapshot),
            snapshot.tallyVolume && this.renderTallyVolumeSmooth(host, snapshot),
            snapshot.warp && this.renderWarp(host, snapshot),
            snapshot.warp && this.renderWarpScale(host, snapshot),
            snapshot.glyph && this.renderGlyph(host, snapshot),
            snapshot.glyph && this.renderGlyphDensity(host, snapshot),
            snapshot.glyph && this.renderGlyphScale(host, snapshot),
            snapshot.solidColor && this.renderSolidColor(host, snapshot),
            snapshot.background && this.renderBackground(host, snapshot),
            snapshot.shading && this.renderShading(host, snapshot),
            snapshot.pointSize && this.renderPointSize(host, snapshot),
            snapshot.lineWidth && this.renderLineWidth(host, snapshot),
            snapshot.opacity && this.renderOpacity(host, snapshot)
        ].filter((row) => row !== undefined && row !== false);
        if (rows.length === 0) {
            return undefined;
        }
        return this.renderSection('display', 'Display', 'symbol-color', rows.length, undefined, <>{rows}</>);
    }

    /**
     * Bivariate (mean + relative error) section. The host only reports it for
     * a color-by cell array with a `-std`/`-rel-err` companion, so absent
     * means either Solid Color or an array without uncertainty — hide the
     * whole section rather than show dead controls. The editor emits the
     * complete next options object and the switch lives beside it; surfaces
     * and voxel blocks cannot carry per-vertex alpha, so the muted note
     * states the two rendering limits up front.
     */
    protected renderUncertaintySection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const bivariate = snapshot.bivariate;
        if (!bivariate) {
            return undefined;
        }
        const approximated = bivariate.channel === 'opacity' || bivariate.channel === 'noise';
        return this.renderSection(
            'uncertainty',
            'Uncertainty',
            'warning',
            1,
            bivariate.enabled,
            <div className="viewer-settings-group viewer-settings-uncertainty">
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'warning',
                        'Uncertainty',
                        'Fade the mean color toward the mask color as the relative statistical error (std / |mean|) grows'
                    )}
                    <NukeSwitch
                        className="viewer-settings-bivariate"
                        ariaLabel="Uncertainty rendering"
                        checked={bivariate.enabled}
                        onChange={() => this.applyPatch(host, { bivariateEnabled: !bivariate.enabled })}
                    />
                </div>
                {bivariate.enabled && (
                    <UncertaintyEditor
                        channel={bivariate.channel}
                        maxRelativeError={bivariate.maxRelativeError}
                        lowQualityColor={bivariate.lowQualityColor}
                        onChange={(options) => this.applyPatch(host, { bivariate: options })}
                    />
                )}
                <div className="viewer-settings-uncertainty-note">
                    {approximated ? 'Opacity and noise render as desaturation on surfaces and voxel blocks (no per-vertex alpha). ' : ''}
                    The smooth volume raycast stays mean-only.
                </div>
            </div>
        );
    }

    protected renderVolumeSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const volume = snapshot.volume;
        if (!volume) {
            return undefined;
        }
        return this.renderSection('volume', 'Volume', 'graph', 5, volume.visible, this.renderVolumeBody(host, volume));
    }

    protected renderVolumeBody(host: ViewerSettingsHost, volume: NonNullable<ViewerSettingsSnapshot['volume']>): React.ReactNode {
        return (
            <div className="viewer-settings-group">
                <div className="viewer-settings-row">
                    {this.renderRowLabel('eye', 'Volume', 'Show the volume representation (boxes or smooth raycast)')}
                    <NukeSwitch
                        className="viewer-settings-volume-visible"
                        ariaLabel="Volume visible"
                        checked={volume.visible}
                        onChange={() => this.applyPatch(host, { volumeVisible: !volume.visible })}
                    />
                </div>
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'symbol-method',
                        'Smooth',
                        'Trilinear raycast volume instead of per-cell voxel boxes (WebGL2 3D texture)'
                    )}
                    <NukeSwitch
                        className="viewer-settings-volume-smooth"
                        ariaLabel="Smooth volume"
                        checked={volume.smooth}
                        onChange={() => this.applyPatch(host, { volumeSmooth: !volume.smooth })}
                    />
                </div>
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'combine',
                        'Blend',
                        'MIP keeps the hottest sample per ray; Composite accumulates front-to-back alpha'
                    )}
                    <NukeSelect
                        className="viewer-settings-volume-blend"
                        ariaLabel="Volume blend mode"
                        value={volume.blendMode}
                        options={[
                            { value: 'mip', label: 'MIP' },
                            { value: 'composite', label: 'Composite' }
                        ]}
                        disabled={!volume.smooth}
                        onChange={(value) => {
                            if (value === 'mip' || value === 'composite') {
                                this.applyPatch(host, { volumeBlendMode: value });
                            }
                        }}
                    />
                </div>
                <div className="viewer-settings-row">
                    {this.renderRowLabel('lightbulb', 'Shade', 'Gradient headlight shading inside the volume (composite or MIP)')}
                    <NukeSwitch
                        className="viewer-settings-volume-shade"
                        ariaLabel="Shade volume"
                        checked={volume.shade}
                        onChange={() => this.applyPatch(host, { volumeShade: !volume.shade })}
                    />
                </div>
                {this.renderVolumeStops(host, volume.opacityStops)}
            </div>
        );
    }

    /**
     * Opacity curve editor: one row per control point with position (display
     * intensity 0-100%) and alpha (0-100%). The viewer normalizes/sorts the
     * list; this panel only emits the edited list.
     */
    protected renderVolumeStops(host: ViewerSettingsHost, stops: readonly OpacityStop[]): React.ReactNode {
        const commit = (next: readonly OpacityStop[]): void => this.applyPatch(host, { volumeOpacityStops: next });
        const replace = (index: number, patch: Partial<OpacityStop>): void => {
            const next = stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop));
            commit(next);
        };
        return (
            <div className="viewer-settings-volume-stops">
                <div className="viewer-settings-row">
                    {this.renderRowLabel('graph', 'Opacity curve', 'Alpha (right) as a function of display intensity (left)')}
                    <Tooltip content="Reset the opacity curve to the linear ramp" position="top">
                        <button
                            className="theia-button secondary viewer-settings-volume-reset"
                            onClick={() => commit(DEFAULT_OPACITY_STOPS)}
                        >
                            Reset
                        </button>
                    </Tooltip>
                </div>
                {stops.map((stop, index) => (
                    <div className="viewer-settings-volume-stop" key={`${index}-${stop.t}`}>
                        <span className="viewer-settings-volume-stop-label">t</span>
                        <NukeSlider
                            className="viewer-settings-volume-stop-position"
                            ariaLabel={`Opacity point ${index + 1} position`}
                            min={0}
                            max={100}
                            step={1}
                            value={Math.round(stop.t * 100)}
                            onChange={(value) => replace(index, { t: value / 100 })}
                        />
                        <span className="viewer-settings-volume-stop-value">{Math.round(stop.t * 100)}%</span>
                        <span className="viewer-settings-volume-stop-label">a</span>
                        <NukeSlider
                            className="viewer-settings-volume-stop-alpha"
                            ariaLabel={`Opacity point ${index + 1} alpha`}
                            min={0}
                            max={100}
                            step={1}
                            value={Math.round(stop.alpha * 100)}
                            onChange={(value) => replace(index, { alpha: value / 100 })}
                        />
                        <Tooltip content={`Remove opacity point ${index + 1}`} position="top">
                            <button
                                className="theia-button secondary viewer-settings-volume-stop-remove"
                                disabled={stops.length <= 2}
                                onClick={() => commit(stops.filter((_, i) => i !== index))}
                            >
                                <i className={codicon('trash')}></i>
                            </button>
                        </Tooltip>
                    </div>
                ))}
                <div className="viewer-settings-row">
                    <Tooltip
                        content={
                            stops.length >= MAX_OPACITY_STOPS
                                ? `Maximum ${MAX_OPACITY_STOPS} opacity points`
                                : 'Add an opacity control point'
                        }
                        position="top"
                    >
                        <button
                            className="theia-button secondary viewer-settings-volume-add"
                            disabled={stops.length >= MAX_OPACITY_STOPS}
                            onClick={() => commit([...stops, { t: 0.5, alpha: 0.5 }])}
                        >
                            <i className={codicon('add')}></i> Add point
                        </button>
                    </Tooltip>
                </div>
            </div>
        );
    }

    protected renderSliceSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const slice = snapshot.slice;
        if (!slice || host.getSlicePreview === undefined) {
            return undefined;
        }
        const preview = host.getSlicePreview(slice);
        return this.renderSection(
            'slice',
            'Slice',
            'layers',
            1,
            false,
            <div className="viewer-settings-group">
                <div className="viewer-settings-row viewer-settings-clip-tabs viewer-settings-slice-tabs">
                    {SLICE_AXES.map((axis) => (
                        <Tooltip key={axis} content={`${axis} orthoslice`} position="top">
                            <button
                                className={`theia-button${slice.axis === axis ? '' : ' secondary'} viewer-settings-clip-tab`}
                                onClick={() => this.applyPatch(host, { sliceAxis: axis })}
                            >
                                {axis}
                            </button>
                        </Tooltip>
                    ))}
                </div>
                <div className="viewer-settings-tip-fill">
                    <Tooltip content={`Slice position (${Math.round(slice.fraction * 100)}%)`} position="top">
                        <NukeSlider
                            className="viewer-settings-slice-position"
                            ariaLabel={`Slice ${slice.axis} position`}
                            min={0}
                            max={100}
                            step={1}
                            value={Math.round(slice.fraction * 100)}
                            onChange={(value) => this.applyPatch(host, { sliceFraction: value / 100 })}
                        />
                    </Tooltip>
                </div>
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'symbol-method',
                        'Smooth',
                        'Blend the two adjacent cell layers (linear) instead of showing one cell layer'
                    )}
                    <NukeSwitch
                        className="viewer-settings-slice-smooth"
                        ariaLabel="Smooth slice"
                        checked={slice.smooth}
                        onChange={() => this.applyPatch(host, { sliceSmooth: !slice.smooth })}
                    />
                </div>
                <div className="viewer-settings-slice-preview-wrap">
                    <SlicePreview
                        width={preview?.width ?? 0}
                        height={preview?.height ?? 0}
                        rgba={preview?.rgba}
                        smooth={slice.smooth}
                        label={`${slice.axis} slice`}
                        emptyMessage="This dataset has no cell-grid slice to preview."
                    />
                </div>
            </div>
        );
    }

    protected renderClipSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const clip = snapshot.clip;
        if (!clip) {
            return undefined;
        }
        return this.renderSection(
            'clip',
            'Clip',
            'layers',
            CLIP_AXES.length,
            anyClipEnabled(clip.state),
            this.renderClipBody(host, snapshot)
        );
    }

    protected renderStepSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        if (!snapshot.step) {
            return undefined;
        }
        return this.renderSection('playback', 'Playback', 'play', 1, undefined, this.renderStep(host, snapshot));
    }

    protected renderMeasureSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const measure = snapshot.measure;
        if (!measure) {
            return undefined;
        }
        return this.renderSection('measure', 'Measure', 'ruler', 1, measure.active, this.renderMeasure(host, snapshot));
    }

    /**
     * Comparison section for a side-by-side comparison session (Wave 5):
     * pane identity plus the camera-link, shared-range and label toggles,
     * the union range readout, and the leave action. The snapshot omits
     * `comparison` when the bound viewer is not in a session, so the whole
     * section stays hidden rather than showing dead controls.
     */
    protected renderComparisonSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const comparison = snapshot.comparison;
        if (!comparison) {
            return undefined;
        }
        return this.renderSection(
            'comparison',
            'Comparison',
            'git-compare',
            3,
            comparison.linkCameras || comparison.sharedRange,
            <div className="viewer-settings-group viewer-settings-comparison">
                <div className="viewer-settings-row viewer-settings-comparison-pane">
                    {this.renderRowLabel(
                        'git-compare',
                        `Pane ${comparison.label}`,
                        `This viewer is pane ${comparison.label} of the active comparison session`
                    )}
                </div>
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'link',
                        'Link cameras',
                        'Sync the orbit direction across comparison panes; each pane keeps its own framing distance'
                    )}
                    <NukeSwitch
                        className="viewer-settings-comparison-link"
                        ariaLabel="Link comparison cameras"
                        checked={comparison.linkCameras}
                        onChange={() => this.applyPatch(host, { comparisonLinkCameras: !comparison.linkCameras })}
                    />
                </div>
                <div className="viewer-settings-row">
                    {this.renderRowLabel('symbol-color', 'Shared color range', "Use the union of every pane's active-array data range")}
                    <NukeSwitch
                        className="viewer-settings-comparison-range"
                        ariaLabel="Shared comparison color range"
                        checked={comparison.sharedRange}
                        onChange={() => this.applyPatch(host, { comparisonSharedRange: !comparison.sharedRange })}
                    />
                </div>
                <div className="viewer-settings-row">
                    {this.renderRowLabel('tag', 'Show pane labels', 'Show the pane letter badge in the viewport corner')}
                    <NukeSwitch
                        className="viewer-settings-comparison-labels"
                        ariaLabel="Show comparison pane labels"
                        checked={comparison.showLabels}
                        onChange={() => this.applyPatch(host, { comparisonShowLabels: !comparison.showLabels })}
                    />
                </div>
                {comparison.sharedRange && comparison.range && (
                    <div className="viewer-settings-comparison-range-value">
                        Shared range: {formatRangeValue(comparison.range[0])} to {formatRangeValue(comparison.range[1])}
                    </div>
                )}
                {comparison.sharedRange && !comparison.range && (
                    <div className="viewer-settings-comparison-range-note">No active scalar array in the panes yet.</div>
                )}
                <div className="viewer-settings-row">
                    <Tooltip content="Leave this comparison and restore the pane's camera link and color range" position="top">
                        <button
                            className="theia-button secondary viewer-settings-comparison-leave"
                            onClick={() => this.applyPatch(host, { comparisonLeave: true })}
                        >
                            <i className={codicon('debug-disconnect')}></i>
                            Leave comparison
                        </button>
                    </Tooltip>
                </div>
            </div>
        );
    }

    protected renderViewSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const grid = snapshot.axesGrid;
        const gridRow = grid ? (
            <div className="viewer-settings-row" key="axes-grid">
                {this.renderRowLabel('ruler', 'Grid', 'Show bounding-box axes with tick labels for the active dataset')}
                <NukeSwitch
                    className="viewer-settings-axes-grid"
                    ariaLabel="Axes grid"
                    checked={grid.visible}
                    onChange={() => this.applyPatch(host, { axesGridVisible: !grid.visible })}
                />
            </div>
        ) : undefined;
        const canRestoreState = host.getViewerState !== undefined && host.applyViewerState !== undefined;
        const hasSavedState = canRestoreState && this.viewerStateMap()[snapshot.widgetId] !== undefined;
        const viewRows = canRestoreState ? (
            <>
                <div className="viewer-settings-row" key="save-view">
                    {this.renderRowLabel('save', 'View state', 'Save the camera and display settings for this viewer tab')}
                    <Tooltip content="Save this viewer's camera and display settings" position="top">
                        <button
                            className="theia-button secondary viewer-settings-save-view"
                            onClick={() => void this.saveViewerState(host, snapshot)}
                        >
                            Save
                        </button>
                    </Tooltip>
                    <Tooltip
                        content={hasSavedState ? 'Restore the saved camera and display settings' : 'No saved view for this tab yet'}
                        position="top"
                    >
                        <button
                            className="theia-button secondary viewer-settings-restore-view"
                            disabled={!hasSavedState}
                            onClick={() => this.restoreViewerState(host, snapshot)}
                        >
                            Restore
                        </button>
                    </Tooltip>
                </div>
            </>
        ) : undefined;
        return this.renderSection(
            'view',
            'View',
            'screen-full',
            VIEWER_SNAP_ACTIONS.length + (gridRow ? 1 : 0) + (viewRows ? 1 : 0),
            undefined,
            <>
                {gridRow}
                {viewRows}
                {this.renderSnap(host)}
            </>
        );
    }

    protected renderColorBy(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const colorBy = snapshot.colorBy;
        if (!colorBy) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="color-by">
                {this.renderRowLabel('symbol-color', 'Color by', 'Color-by array (applies instantly, no viewer restart)')}
                <NukeSelect
                    className="viewer-settings-color-by"
                    ariaLabel="Color-by array"
                    value={colorBy.value}
                    options={colorBy.options}
                    onChange={(value) => this.applyPatch(host, { colorBy: value })}
                />
            </div>
        );
    }

    protected renderComponent(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const component = snapshot.component;
        if (!component) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="component">
                {this.renderRowLabel('symbol-numeric', 'Component', 'Vector component of the color-by array (Magnitude is the L2 norm)')}
                <NukeSelect
                    className="viewer-settings-component"
                    ariaLabel="Vector component"
                    value={String(component.value)}
                    options={component.options.map((option) => ({ value: String(option.value), label: option.label }))}
                    onChange={(value) => this.applyPatch(host, { component: parseInt(value, 10) })}
                />
            </div>
        );
    }

    protected renderColormap(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const colormap = snapshot.colormap;
        if (!colormap) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="colormap">
                {this.renderRowLabel(
                    'paintcan',
                    'Map',
                    colormap.disabled ? 'Colormap (select a data array in Color by first)' : 'Colormap (applies instantly)'
                )}
                <NukeSelect
                    className="viewer-settings-colormap"
                    ariaLabel="Colormap"
                    value={colormap.value}
                    options={colormap.options.map((name) => ({ value: name, label: name }))}
                    disabled={colormap.disabled}
                    onChange={(value) => this.applyPatch(host, { colormap: value })}
                />
                <Tooltip content="Sample the colormap in reverse (legend gradient honors it)" position="top">
                    <button
                        className={`theia-button secondary viewer-settings-map-toggle${colormap.invert ? ' active' : ''}`}
                        aria-pressed={colormap.invert}
                        aria-label="Invert colormap"
                        disabled={colormap.disabled}
                        onClick={() => this.applyPatch(host, { invert: !colormap.invert })}
                    >
                        Invert
                    </button>
                </Tooltip>
                <Tooltip
                    content={colormap.logScale.disabled ? 'Log scale needs a strictly positive range' : 'Map values on a log scale'}
                    position="top"
                >
                    <button
                        className={`theia-button secondary viewer-settings-map-toggle${colormap.logScale.value ? ' active' : ''}`}
                        aria-pressed={colormap.logScale.value}
                        aria-label="Log-scale colormap"
                        disabled={colormap.disabled || colormap.logScale.disabled}
                        onClick={() => this.applyPatch(host, { logScale: !colormap.logScale.value })}
                    >
                        Log
                    </button>
                </Tooltip>
            </div>
        );
    }

    protected renderRange(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const range = snapshot.range;
        if (!range) {
            return undefined;
        }
        const commit = (input: HTMLInputElement, isMin: boolean): void => {
            const value = parseFloat(input.value);
            if (Number.isNaN(value)) {
                return;
            }
            this.applyPatch(host, { range: isMin ? [value, range.max] : [range.min, value] });
        };
        const minThumb = rangeValueToSlider(range.min, range.dataMin, range.dataMax);
        const maxThumb = rangeValueToSlider(range.max, range.dataMin, range.dataMax);
        const dragMin = (thumb: number): void => {
            this.applyPatch(host, { range: [rangeSliderToValue(Math.min(thumb, maxThumb), range.dataMin, range.dataMax), range.max] });
        };
        const dragMax = (thumb: number): void => {
            this.applyPatch(host, { range: [range.min, rangeSliderToValue(Math.max(thumb, minThumb), range.dataMin, range.dataMax)] });
        };
        return (
            <div className="viewer-settings-range-wrap" key="range">
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'graph',
                        'Range',
                        `Custom range clamps the colormap to [min, max]; Auto restores the data range (${range.dataMin} to ${range.dataMax})`
                    )}
                    <Tooltip content={`Restore the data range (${range.dataMin} to ${range.dataMax})`} position="top">
                        <button
                            className={`theia-button secondary viewer-settings-range-auto${range.mode === 'auto' ? ' active' : ''}`}
                            aria-pressed={range.mode === 'auto'}
                            onClick={() => this.applyPatch(host, { range: 'auto' })}
                        >
                            Auto
                        </button>
                    </Tooltip>
                    <Tooltip content={`Custom range minimum (data min ${range.dataMin})`} position="top">
                        <input
                            type="number"
                            className="viewer-settings-range-input"
                            key={`min-${range.min}`}
                            defaultValue={range.min}
                            step="any"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    commit(e.currentTarget, true);
                                }
                            }}
                            onBlur={(e) => commit(e.currentTarget, true)}
                        />
                    </Tooltip>
                    <Tooltip content={`Reset minimum to the data min (${range.dataMin})`} position="top">
                        <button
                            type="button"
                            className="viewer-settings-range-reset"
                            aria-label="Reset range minimum to data min"
                            onClick={() => this.applyPatch(host, { range: [range.dataMin, range.max] })}
                        >
                            <i className={codicon('refresh')}></i>
                        </button>
                    </Tooltip>
                    <Tooltip content={`Custom range maximum (data max ${range.dataMax})`} position="top">
                        <input
                            type="number"
                            className="viewer-settings-range-input"
                            key={`max-${range.max}`}
                            defaultValue={range.max}
                            step="any"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    commit(e.currentTarget, false);
                                }
                            }}
                            onBlur={(e) => commit(e.currentTarget, false)}
                        />
                    </Tooltip>
                    <Tooltip content={`Reset maximum to the data max (${range.dataMax})`} position="top">
                        <button
                            type="button"
                            className="viewer-settings-range-reset"
                            aria-label="Reset range maximum to data max"
                            onClick={() => this.applyPatch(host, { range: [range.min, range.dataMax] })}
                        >
                            <i className={codicon('refresh')}></i>
                        </button>
                    </Tooltip>
                </div>
                <div className="viewer-settings-range-slider" role="group" aria-label="Custom color range slider">
                    <div className="viewer-settings-range-track"></div>
                    <div
                        className="viewer-settings-range-fill"
                        style={{
                            left: `${(minThumb / RANGE_SLIDER_STEPS) * 100}%`,
                            width: `${((maxThumb - minThumb) / RANGE_SLIDER_STEPS) * 100}%`
                        }}
                    ></div>
                    <input
                        type="range"
                        className="viewer-settings-range-thumb"
                        aria-label={`Custom range minimum slider (currently ${range.min})`}
                        min={0}
                        max={RANGE_SLIDER_STEPS}
                        step={1}
                        value={minThumb}
                        onChange={(e) => dragMin(Number(e.currentTarget.value))}
                    />
                    <input
                        type="range"
                        className="viewer-settings-range-thumb"
                        aria-label={`Custom range maximum slider (currently ${range.max})`}
                        min={0}
                        max={RANGE_SLIDER_STEPS}
                        step={1}
                        value={maxThumb}
                        onChange={(e) => dragMax(Number(e.currentTarget.value))}
                    />
                </div>
            </div>
        );
    }

    protected renderThreshold(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const threshold = snapshot.threshold;
        if (!threshold) {
            return undefined;
        }
        const commit = (input: HTMLInputElement, isMin: boolean): void => {
            const value = parseFloat(input.value);
            if (Number.isNaN(value)) {
                return;
            }
            this.applyPatch(host, { thresholdRange: isMin ? [value, threshold.max] : [threshold.min, value] });
        };
        const minThumb = rangeValueToSlider(threshold.min, threshold.dataMin, threshold.dataMax);
        const maxThumb = rangeValueToSlider(threshold.max, threshold.dataMin, threshold.dataMax);
        const dragMin = (thumb: number): void => {
            this.applyPatch(host, {
                thresholdRange: [rangeSliderToValue(Math.min(thumb, maxThumb), threshold.dataMin, threshold.dataMax), threshold.max]
            });
        };
        const dragMax = (thumb: number): void => {
            this.applyPatch(host, {
                thresholdRange: [threshold.min, rangeSliderToValue(Math.max(thumb, minThumb), threshold.dataMin, threshold.dataMax)]
            });
        };
        return (
            <div className="viewer-settings-range-wrap" key="threshold">
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'filter',
                        'Threshold',
                        `Hide cells whose active-array value falls outside [min, max] (${threshold.visible} of ${threshold.total} shown; ` +
                            `non-finite values stay visible; enabling with the data range hides nothing)`
                    )}
                    <NukeSwitch
                        className="viewer-settings-threshold"
                        ariaLabel="Threshold cells outside the range"
                        checked={threshold.enabled}
                        onChange={() => this.applyPatch(host, { thresholdEnabled: !threshold.enabled })}
                    />
                    <Tooltip content={`Restore the full data range (${threshold.dataMin} to ${threshold.dataMax})`} position="top">
                        <button
                            className="theia-button secondary viewer-settings-range-reset"
                            aria-label="Reset threshold to the data range"
                            onClick={() => this.applyPatch(host, { thresholdRange: 'data' })}
                        >
                            <i className={codicon('refresh')}></i>
                        </button>
                    </Tooltip>
                    <Tooltip content={`Threshold minimum (data min ${threshold.dataMin})`} position="top">
                        <input
                            type="number"
                            className="viewer-settings-range-input"
                            key={`threshold-min-${threshold.min}`}
                            defaultValue={threshold.min}
                            step="any"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    commit(e.currentTarget, true);
                                }
                            }}
                            onBlur={(e) => commit(e.currentTarget, true)}
                        />
                    </Tooltip>
                    <Tooltip content={`Reset threshold minimum to the data min (${threshold.dataMin})`} position="top">
                        <button
                            type="button"
                            className="viewer-settings-range-reset"
                            aria-label="Reset threshold minimum to data min"
                            onClick={() => this.applyPatch(host, { thresholdRange: [threshold.dataMin, threshold.max] })}
                        >
                            <i className={codicon('refresh')}></i>
                        </button>
                    </Tooltip>
                    <Tooltip content={`Threshold maximum (data max ${threshold.dataMax})`} position="top">
                        <input
                            type="number"
                            className="viewer-settings-range-input"
                            key={`threshold-max-${threshold.max}`}
                            defaultValue={threshold.max}
                            step="any"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    commit(e.currentTarget, false);
                                }
                            }}
                            onBlur={(e) => commit(e.currentTarget, false)}
                        />
                    </Tooltip>
                    <Tooltip content={`Reset threshold maximum to the data max (${threshold.dataMax})`} position="top">
                        <button
                            type="button"
                            className="viewer-settings-range-reset"
                            aria-label="Reset threshold maximum to data max"
                            onClick={() => this.applyPatch(host, { thresholdRange: [threshold.min, threshold.dataMax] })}
                        >
                            <i className={codicon('refresh')}></i>
                        </button>
                    </Tooltip>
                </div>
                <div className="viewer-settings-range-slider" role="group" aria-label="Threshold window slider">
                    <div className="viewer-settings-range-track"></div>
                    <div
                        className="viewer-settings-range-fill"
                        style={{
                            left: `${(minThumb / RANGE_SLIDER_STEPS) * 100}%`,
                            width: `${((maxThumb - minThumb) / RANGE_SLIDER_STEPS) * 100}%`
                        }}
                    ></div>
                    <input
                        type="range"
                        className="viewer-settings-range-thumb"
                        aria-label={`Threshold minimum slider (currently ${threshold.min})`}
                        min={0}
                        max={RANGE_SLIDER_STEPS}
                        step={1}
                        value={minThumb}
                        onChange={(e) => dragMin(Number(e.currentTarget.value))}
                    />
                    <input
                        type="range"
                        className="viewer-settings-range-thumb"
                        aria-label={`Threshold maximum slider (currently ${threshold.max})`}
                        min={0}
                        max={RANGE_SLIDER_STEPS}
                        step={1}
                        value={maxThumb}
                        onChange={(e) => dragMax(Number(e.currentTarget.value))}
                    />
                </div>
            </div>
        );
    }

    protected renderScalarBar(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const scalarBar = snapshot.scalarBar;
        if (!scalarBar) {
            return undefined;
        }
        const commitTitle = (input: HTMLInputElement): void => {
            this.applyPatch(host, { scalarBarTitle: input.value.trim() });
        };
        return (
            <React.Fragment key="scalar-bar-group">
                <div className="viewer-settings-row" key="scalar-bar">
                    {this.renderRowLabel('symbol-color', 'Color legend', 'Show the color legend for the active colormap')}
                    <NukeSwitch
                        className="viewer-settings-scalar-bar"
                        ariaLabel="Color legend"
                        checked={scalarBar.visible}
                        onChange={() => this.applyPatch(host, { scalarBarVisible: !scalarBar.visible })}
                    />
                </div>
                {scalarBar.visible && (
                    <>
                        <div className="viewer-settings-row" key="scalar-bar-title">
                            {this.renderRowLabel('symbol-string', 'Title', 'Legend title; leave empty to show the active array name')}
                            <input
                                type="text"
                                className="viewer-settings-legend-title"
                                aria-label="Color legend title"
                                key={scalarBar.title ?? ''}
                                defaultValue={scalarBar.title ?? ''}
                                placeholder="Array name"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        commitTitle(e.currentTarget);
                                    }
                                }}
                                onBlur={(e) => commitTitle(e.currentTarget)}
                            />
                        </div>
                        <div className="viewer-settings-row" key="scalar-bar-vertical">
                            {this.renderRowLabel('list-vertical', 'Vertical labels', 'Stack the legend min/max labels vertically')}
                            <NukeSwitch
                                className="viewer-settings-legend-vertical"
                                ariaLabel="Vertical legend labels"
                                checked={scalarBar.verticalLabels ?? false}
                                onChange={() => this.applyPatch(host, { scalarBarVertical: !(scalarBar.verticalLabels ?? false) })}
                            />
                        </div>
                    </>
                )}
            </React.Fragment>
        );
    }

    protected renderTallyVolume(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const tallyVolume = snapshot.tallyVolume;
        if (!tallyVolume) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="tally-volume">
                {this.renderRowLabel('graph-scatter', 'Tally volume', 'Show the tally mesh volume inside the geometry (drape interior)')}
                <NukeSwitch
                    className="viewer-settings-tally-volume"
                    ariaLabel="Tally volume"
                    checked={tallyVolume.visible}
                    onChange={() => this.applyPatch(host, { tallyVolumeVisible: !tallyVolume.visible })}
                />
            </div>
        );
    }

    protected renderTallyVolumeSmooth(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const tallyVolume = snapshot.tallyVolume;
        if (!tallyVolume) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="tally-volume-smooth">
                {this.renderRowLabel(
                    'symbol-method',
                    'Smooth volume',
                    'Trilinear raycast volume instead of per-cell voxel boxes (same colors, WebGL2)'
                )}
                <NukeSwitch
                    className="viewer-settings-tally-volume-smooth"
                    ariaLabel="Smooth volume"
                    checked={tallyVolume.smooth}
                    onChange={() => this.applyPatch(host, { tallyVolumeSmooth: !tallyVolume.smooth })}
                />
            </div>
        );
    }

    protected renderWarp(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const warp = snapshot.warp;
        if (!warp) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="warp">
                {this.renderRowLabel(
                    'move',
                    'Warp',
                    'Displace the mesh along a 3-component vector array (FEM deformation, magnified; applies instantly)'
                )}
                <NukeSwitch
                    className="viewer-settings-warp"
                    ariaLabel="Warp by vector"
                    checked={warp.enabled}
                    onChange={() => this.applyPatch(host, { warpEnabled: !warp.enabled })}
                />
                <NukeSelect
                    className="viewer-settings-warp-array"
                    ariaLabel="Warp vector array"
                    value={warp.array}
                    options={warp.options}
                    disabled={!warp.enabled}
                    onChange={(value) => this.applyPatch(host, { warpArray: value })}
                />
            </div>
        );
    }

    protected renderWarpScale(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const warp = snapshot.warp;
        if (!warp) {
            return undefined;
        }
        // Editing the value implies a capped exaggeration (Range-pattern:
        // edits leave Auto for custom), clamped to the slider maximum.
        const commit = (input: HTMLInputElement): void => {
            const value = parseFloat(input.value);
            if (Number.isNaN(value)) {
                return;
            }
            this.applyPatch(host, { warpScaleMode: 'capped', warpScale: value });
        };
        return (
            <div className="viewer-settings-range-wrap" key="warp-scale">
                <div className="viewer-settings-row">
                    {this.renderRowLabel(
                        'graph',
                        'Exaggeration',
                        `Warp exaggeration (True applies x1 displacement, Auto applies x${warp.autoScale} = 10% of the model size, ` +
                            `Capped clamps the slider to x${WARP_EXAGGERATION_SPEC.max}; currently applying x${warp.effectiveScale})`
                    )}
                    <NukeSelect
                        className="viewer-settings-warp-mode"
                        ariaLabel="Warp scale mode"
                        value={warp.scaleMode}
                        options={WARP_SCALE_MODES.map((mode) => ({ value: mode.id, label: mode.label }))}
                        disabled={!warp.enabled}
                        onChange={(value) => {
                            if (isWarpScaleMode(value)) {
                                this.applyPatch(host, { warpScaleMode: value });
                            }
                        }}
                    />
                    <Tooltip content={`Custom exaggeration (currently applying x${warp.effectiveScale})`} position="top">
                        <input
                            type="number"
                            className="viewer-settings-range-input"
                            key={`warp-${warp.scale}`}
                            defaultValue={warp.scale}
                            step="any"
                            disabled={!warp.enabled}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    commit(e.currentTarget);
                                }
                            }}
                            onBlur={(e) => commit(e.currentTarget)}
                        />
                    </Tooltip>
                    <Tooltip content={`Reset exaggeration to the auto scale (x${warp.autoScale})`} position="top">
                        <button
                            type="button"
                            className="viewer-settings-range-reset"
                            aria-label="Reset warp exaggeration to the auto scale"
                            disabled={!warp.enabled}
                            onClick={() => this.applyPatch(host, { warpScaleMode: 'capped', warpScale: warp.autoScale })}
                        >
                            <i className={codicon('refresh')}></i>
                        </button>
                    </Tooltip>
                </div>
                <div className="viewer-settings-row">
                    <div className="viewer-settings-tip-fill">
                        <Tooltip content="Warp exaggeration slider (editing switches to Capped mode)" position="top">
                            <NukeSlider
                                className="viewer-settings-warp-scale"
                                ariaLabel={`Warp exaggeration (currently ${warp.scale})`}
                                min={WARP_EXAGGERATION_SPEC.min}
                                max={WARP_EXAGGERATION_SPEC.max}
                                step={WARP_EXAGGERATION_SPEC.step}
                                value={warp.scale}
                                disabled={!warp.enabled}
                                onChange={(value) => this.applyPatch(host, { warpScaleMode: 'capped', warpScale: value })}
                            />
                        </Tooltip>
                    </div>
                </div>
            </div>
        );
    }

    protected renderGlyph(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const glyph = snapshot.glyph;
        if (!glyph) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="glyph">
                {this.renderRowLabel(
                    'arrow-up',
                    'Glyphs',
                    `Direction cones along per-point vectors (tracks: polyline tangents; ${glyph.count} of ${glyph.total} shown; ` +
                        'zero-length vectors and threshold-hidden points skipped; applies instantly)'
                )}
                <NukeSwitch
                    className="viewer-settings-glyph"
                    ariaLabel="Direction glyphs"
                    checked={glyph.enabled}
                    onChange={() => this.applyPatch(host, { glyphEnabled: !glyph.enabled })}
                />
            </div>
        );
    }

    protected renderGlyphDensity(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const glyph = snapshot.glyph;
        if (!glyph) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="glyph-density">
                {this.renderRowLabel(
                    'graph-scatter',
                    'Density',
                    `Fraction of candidate points carrying a cone (currently ${glyph.count} of ${glyph.total}; capped for interactivity)`
                )}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Glyph density slider (fraction of points shown)" position="top">
                        <NukeSlider
                            className="viewer-settings-glyph-density"
                            ariaLabel={`Glyph density (currently ${glyph.density})`}
                            min={GLYPH_DENSITY_SPEC.min}
                            max={GLYPH_DENSITY_SPEC.max}
                            step={GLYPH_DENSITY_SPEC.step}
                            value={glyph.density}
                            disabled={!glyph.enabled}
                            onChange={(value) => this.applyPatch(host, { glyphDensity: value })}
                        />
                    </Tooltip>
                </div>
                <Tooltip content={`Reset density to the default (${DEFAULT_GLYPH_DENSITY})`} position="top">
                    <button
                        type="button"
                        className="viewer-settings-range-reset"
                        aria-label="Reset glyph density to the default"
                        disabled={!glyph.enabled}
                        onClick={() => this.applyPatch(host, { glyphDensity: DEFAULT_GLYPH_DENSITY })}
                    >
                        <i className={codicon('refresh')}></i>
                    </button>
                </Tooltip>
            </div>
        );
    }

    protected renderGlyphScale(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const glyph = snapshot.glyph;
        if (!glyph) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="glyph-scale">
                {this.renderRowLabel(
                    'symbol-numeric',
                    'Glyph size',
                    `Cone size multiplier over the auto height (1 = model diagonal / 40; currently x${glyph.scale})`
                )}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Glyph size slider (multiplier over the auto cone height)" position="top">
                        <NukeSlider
                            className="viewer-settings-glyph-scale"
                            ariaLabel={`Glyph size (currently ${glyph.scale})`}
                            min={GLYPH_SCALE_SPEC.min}
                            max={GLYPH_SCALE_SPEC.max}
                            step={GLYPH_SCALE_SPEC.step}
                            value={glyph.scale}
                            disabled={!glyph.enabled}
                            onChange={(value) => this.applyPatch(host, { glyphScale: value })}
                        />
                    </Tooltip>
                </div>
                <Tooltip content={`Reset glyph size to the default (x${DEFAULT_GLYPH_SCALE})`} position="top">
                    <button
                        type="button"
                        className="viewer-settings-range-reset"
                        aria-label="Reset glyph size to the default"
                        disabled={!glyph.enabled}
                        onClick={() => this.applyPatch(host, { glyphScale: DEFAULT_GLYPH_SCALE })}
                    >
                        <i className={codicon('refresh')}></i>
                    </button>
                </Tooltip>
            </div>
        );
    }

    protected renderSolidColor(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const solidColor = snapshot.solidColor;
        if (!solidColor) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="solid-color">
                {this.renderRowLabel(
                    'circle-filled',
                    'Solid color',
                    'Uniform surface color (Solid Color mode; pick a data array in Color by to map values instead)'
                )}
                <ColorPicker value={solidColor.value} onChange={(color) => this.applyPatch(host, { solidColor: color })} />
            </div>
        );
    }

    protected renderBackground(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const background = snapshot.background;
        if (!background) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="background">
                {this.renderRowLabel('layout-panel', 'Background', 'Viewport background color')}
                <ColorPicker value={background.value} onChange={(color) => this.applyPatch(host, { background: color })} />
            </div>
        );
    }

    protected renderShading(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const shading = snapshot.shading;
        if (!shading) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="shading">
                {this.renderRowLabel('layers', 'Shading', 'Shading mode (applies instantly)')}
                <NukeSelect
                    className="viewer-settings-shading"
                    ariaLabel="Shading mode"
                    value={shading.value}
                    options={VIEWER_SHADING_MODES.map((mode) => ({ value: mode.id, label: mode.label }))}
                    onChange={(value) => {
                        if (isViewerShadingMode(value)) {
                            this.applyPatch(host, { shading: value });
                        }
                    }}
                />
            </div>
        );
    }

    protected renderClipBody(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const clip = snapshot.clip;
        if (!clip) {
            return undefined;
        }
        const tab = clip.state[clip.tab];
        const enabledCount = CLIP_AXES.filter((axis) => clip.state[axis].enabled).length;
        return (
            <div className="viewer-settings-group">
                <div className="viewer-settings-row">
                    <Tooltip
                        content={`Clip planes: ${enabledCount} of ${CLIP_AXES.length} enabled (enabled planes apply together as a box section)`}
                        position="right"
                    >
                        <span className="viewer-settings-row-label">Clip</span>
                    </Tooltip>
                    <NukeSwitch
                        className="viewer-settings-clip-master"
                        ariaLabel="Clip planes"
                        checked={anyClipEnabled(clip.state)}
                        onChange={(checked) => this.applyPatch(host, { clip: setAllClipEnabled(clip.state, checked) })}
                    />
                </div>
                {clip.caps !== undefined && (
                    <div className="viewer-settings-row">
                        {this.renderRowLabel(
                            'circuit-board',
                            'Cap cut',
                            'Fill the clipped cross-section with a solid cap (closed triangle meshes only)'
                        )}
                        <NukeSwitch
                            className="viewer-settings-clip-caps"
                            ariaLabel="Cap clip cuts"
                            checked={clip.caps}
                            onChange={() => this.applyPatch(host, { clipCaps: !clip.caps })}
                        />
                    </div>
                )}
                <div className="viewer-settings-row viewer-settings-clip-tabs">
                    {CLIP_AXES.map((axis) => (
                        <Tooltip key={axis} content={`Clip ${axis} plane settings`} position="top">
                            <button
                                className={`theia-button${clip.tab === axis ? '' : ' secondary'} viewer-settings-clip-tab`}
                                onClick={() => this.applyPatch(host, { clipTab: axis })}
                            >
                                {axis}
                            </button>
                        </Tooltip>
                    ))}
                    <Tooltip content={`Flip kept ${clip.tab} half-space (enables the plane)`} position="top">
                        <button
                            className="theia-button secondary viewer-settings-clip-flip"
                            onClick={() =>
                                this.applyPatch(host, {
                                    clip: updateAxisClip(clip.state, clip.tab, { enabled: true, invert: !tab.invert })
                                })
                            }
                        >
                            {tab.invert ? 'Unflip' : 'Flip'}
                        </button>
                    </Tooltip>
                </div>
                <div className="viewer-settings-tip-fill">
                    <Tooltip content={`Clip ${clip.tab} position (percent across the dataset; enables the plane)`} position="top">
                        <NukeSlider
                            className="viewer-settings-clip-position"
                            ariaLabel={`Clip ${clip.tab} position`}
                            min={0}
                            max={100}
                            step={1}
                            value={Math.round(tab.fraction * 100)}
                            onChange={(value) =>
                                this.applyPatch(host, {
                                    clip: updateAxisClip(clip.state, clip.tab, { enabled: true, fraction: value / 100 })
                                })
                            }
                        />
                    </Tooltip>
                </div>
            </div>
        );
    }

    protected renderOpacity(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const opacity = snapshot.opacity;
        if (!opacity) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="opacity">
                {this.renderRowLabel('circle-outline', 'Opacity', 'Material opacity')}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Material opacity" position="top">
                        <NukeSlider
                            className="viewer-settings-opacity"
                            ariaLabel="Material opacity"
                            min={opacity.min}
                            max={opacity.max}
                            step={opacity.step}
                            value={opacity.value}
                            onChange={(value) => this.applyPatch(host, { opacity: value })}
                        />
                    </Tooltip>
                </div>
            </div>
        );
    }

    protected renderPointSize(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const pointSize = snapshot.pointSize;
        if (!pointSize) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="point-size">
                {this.renderRowLabel('circle-small', 'Point size', 'Render point size')}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Render point size" position="top">
                        <NukeSlider
                            className="viewer-settings-point-size"
                            ariaLabel="Render point size"
                            min={pointSize.min}
                            max={pointSize.max}
                            step={pointSize.step}
                            value={pointSize.value}
                            onChange={(value) => this.applyPatch(host, { pointSize: value })}
                        />
                    </Tooltip>
                </div>
            </div>
        );
    }

    protected renderLineWidth(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const lineWidth = snapshot.lineWidth;
        if (!lineWidth) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="line-width">
                {this.renderRowLabel('horizontal-rule', 'Line width', 'Render line width')}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Render line width" position="top">
                        <NukeSlider
                            className="viewer-settings-line-width"
                            ariaLabel="Render line width"
                            min={lineWidth.min}
                            max={lineWidth.max}
                            step={lineWidth.step}
                            value={lineWidth.value}
                            onChange={(value) => this.applyPatch(host, { lineWidth: value })}
                        />
                    </Tooltip>
                </div>
            </div>
        );
    }

    protected renderStep(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const step = snapshot.step;
        if (!step) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="step">
                {this.renderRowLabel('play', `Step ${step.label}`, 'Exodus time step')}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Exodus time step" position="top">
                        <NukeSlider
                            className="viewer-settings-step"
                            ariaLabel="Exodus time step"
                            min={0}
                            max={step.count - 1}
                            step={1}
                            value={step.index}
                            onChange={(value) => this.applyPatch(host, { stepIndex: Math.round(value) })}
                        />
                    </Tooltip>
                </div>
            </div>
        );
    }

    protected renderMeasure(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const measure = snapshot.measure;
        if (!measure) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row">
                <Tooltip
                    content={
                        measure.active
                            ? 'Measure: click two surface points (Escape cancels)'
                            : 'Measure distance between two surface points'
                    }
                    position="right"
                >
                    <button
                        className={`theia-button secondary viewer-measure-toggle viewer-settings-measure${measure.active ? ' active' : ''}`}
                        aria-pressed={measure.active}
                        aria-label="Measure distance"
                        onClick={() => this.applyPatch(host, { measureActive: !measure.active })}
                    >
                        <i className={codicon('ruler')}></i>
                        Measure
                    </button>
                </Tooltip>
                <span className={`viewer-settings-state-dot${measure.active ? ' is-on' : ''}`}></span>
            </div>
        );
    }

    protected renderSnap(host: ViewerSettingsHost): React.ReactNode {
        return (
            <div className="viewer-settings-group">
                <div className="viewer-settings-row viewer-settings-snap-row">
                    {VIEWER_SNAP_ACTIONS.map((action) => (
                        <Tooltip key={action.id} content={action.tooltip} position="top">
                            <button
                                className={`theia-button secondary viewer-settings-snap-${action.id}`}
                                onClick={() => this.applyPatch(host, { snap: action.id })}
                            >
                                {action.label}
                            </button>
                        </Tooltip>
                    ))}
                </div>
            </div>
        );
    }
}
