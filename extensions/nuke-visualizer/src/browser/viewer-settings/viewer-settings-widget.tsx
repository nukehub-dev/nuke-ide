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
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { ColorPicker, NukeSelect, NukeSlider, NukeSwitch, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { NativeVtkViewerWidget } from '../plugins/openmc/widgets/native-vtk-viewer-widget';
import { DagmcViewerWidget } from '../plugins/openmc/widgets/dagmc/dagmc-viewer-widget';
import { GeometryNativeViewerWidget } from '../plugins/openmc/widgets/geometry-native/geometry-native-viewer-widget';
import { ExodusTimeSliderWidget } from '../plugins/openmc/widgets/exodus-series/exodus-time-slider-widget';
import { anyClipEnabled, CLIP_AXES, setAllClipEnabled, updateAxisClip } from '../viewer-core/clip-plane';
import { isViewerShadingMode, VIEWER_SHADING_MODES } from '../viewer-core/shading-mode';
import {
    resolveViewerSettingsTargetId,
    VIEWER_SNAP_ACTIONS,
    ViewerSettingsHost,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot
} from './viewer-settings-model';
import './viewer-settings.css';

/**
 * Viewer Settings sidebar panel: display settings for the active native 3D
 * viewer (color-by array/component, colormap, range, legend, solid color,
 * background, shading, point/line size, opacity, clip, measure, axis snaps)
 * in one Theia/React view, following the Model Outline active-widget pattern.
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
 */
@injectable()
export class ViewerSettingsWidget extends ReactWidget {
    static readonly ID = 'nuke-visualizer-viewer-settings-widget';
    static readonly LABEL = 'Viewer Settings';

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    protected activeViewer: Widget | undefined;
    /** Panel-local collapsed sections (CAD TreeSection pattern); viewer state is never cached here. */
    protected collapsedSections = new Set<string>();

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
     * count badge, with an optional live status dot (clip planes active,
     * measure armed). Collapse is panel-local; the body keeps every
     * existing control hook unchanged.
     */
    protected renderSection(
        id: string,
        label: string,
        icon: string,
        count: string,
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
                {!snapshot.hasDataset ? (
                    <div className="viewer-settings-empty">
                        <p>No dataset loaded yet.</p>
                        <span className="empty-hint">Settings appear here once the viewer finishes loading its file.</span>
                    </div>
                ) : (
                    host && (
                        <>
                            {this.renderDisplaySection(host, snapshot)}
                            {this.renderClipSection(host, snapshot)}
                            {this.renderStepSection(host, snapshot)}
                            {this.renderMeasureSection(host, snapshot)}
                            {this.renderViewSection(host)}
                        </>
                    )
                )}
            </div>
        );
    }

    protected renderDisplaySection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const rows = [
            snapshot.colorBy && this.renderColorBy(host, snapshot),
            snapshot.component && this.renderComponent(host, snapshot),
            snapshot.colormap && this.renderColormap(host, snapshot),
            snapshot.range && this.renderRange(host, snapshot),
            snapshot.scalarBar && this.renderScalarBar(host, snapshot),
            snapshot.tallyVolume && this.renderTallyVolume(host, snapshot),
            snapshot.tallyVolume && this.renderTallyVolumeSmooth(host, snapshot),
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
        return this.renderSection('display', 'Display', 'symbol-color', `${rows.length}`, undefined, <>{rows}</>);
    }

    protected renderClipSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const clip = snapshot.clip;
        if (!clip) {
            return undefined;
        }
        const enabledCount = CLIP_AXES.filter((axis) => clip.state[axis].enabled).length;
        return this.renderSection(
            'clip',
            'Clip',
            'layers',
            `${enabledCount}/${CLIP_AXES.length}`,
            anyClipEnabled(clip.state),
            this.renderClipBody(host, snapshot)
        );
    }

    protected renderStepSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        if (!snapshot.step) {
            return undefined;
        }
        return this.renderSection('playback', 'Playback', 'play', '1', undefined, this.renderStep(host, snapshot));
    }

    protected renderMeasureSection(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const measure = snapshot.measure;
        if (!measure) {
            return undefined;
        }
        return this.renderSection('measure', 'Measure', 'ruler', '1', measure.active, this.renderMeasure(host, snapshot));
    }

    protected renderViewSection(host: ViewerSettingsHost): React.ReactNode {
        return this.renderSection('view', 'View', 'screen-full', `${VIEWER_SNAP_ACTIONS.length}`, undefined, this.renderSnap(host));
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
        return (
            <div className="viewer-settings-row" key="range">
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
            </div>
        );
    }

    protected renderScalarBar(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const scalarBar = snapshot.scalarBar;
        if (!scalarBar) {
            return undefined;
        }
        return (
            <div className="viewer-settings-row" key="scalar-bar">
                {this.renderRowLabel('symbol-color', 'Color legend', 'Show the color legend for the active colormap')}
                <NukeSwitch
                    className="viewer-settings-scalar-bar"
                    ariaLabel="Color legend"
                    checked={scalarBar.visible}
                    onChange={() => this.applyPatch(host, { scalarBarVisible: !scalarBar.visible })}
                />
            </div>
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
        return (
            <div className="viewer-settings-group">
                <div className="viewer-settings-row">
                    <Tooltip content="Clip planes: enabled planes apply together (box-section view)" position="right">
                        <span className="viewer-settings-row-label">Clip</span>
                    </Tooltip>
                    <NukeSwitch
                        className="viewer-settings-clip-master"
                        ariaLabel="Clip planes"
                        checked={anyClipEnabled(clip.state)}
                        onChange={(checked) => this.applyPatch(host, { clip: setAllClipEnabled(clip.state, checked) })}
                    />
                </div>
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
