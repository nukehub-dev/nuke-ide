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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
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
 * viewer (color-by, colormap, shading, clip, measure, axis snaps) in one
 * Theia/React view, following the Model Outline active-widget pattern.
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
     * Rebind to the active viewer tab (active wins, otherwise current).
     * The binding is sticky: shell events fired by interacting with this
     * panel resolve to no viewer, and must not unbind the tab being
     * adjusted — only another viewer tab switches the binding, and a
     * disposed (closed) tab drops it.
     */
    protected refreshActiveViewer(): void {
        const active = this.shell.activeWidget;
        const current = this.shell.currentWidget;
        const targetId = resolveViewerSettingsTargetId(active?.id, current?.id);
        if (targetId !== undefined) {
            const next = active?.id === targetId ? active : current?.id === targetId ? current : undefined;
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
            snapshot.colormap && this.renderColormap(host, snapshot),
            snapshot.shading && this.renderShading(host, snapshot),
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
            <label className="viewer-settings-row" key="color-by">
                {this.renderRowLabel('symbol-color', 'Color by', 'Color-by array (applies instantly, no viewer restart)')}
                <select
                    className="viewer-settings-color-by"
                    value={colorBy.value}
                    onChange={(e) => this.applyPatch(host, { colorBy: e.target.value })}
                >
                    {colorBy.options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    protected renderColormap(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const colormap = snapshot.colormap;
        if (!colormap) {
            return undefined;
        }
        return (
            <label className="viewer-settings-row" key="colormap">
                {this.renderRowLabel(
                    'paintcan',
                    'Map',
                    colormap.disabled ? 'Colormap (select a data array in Color by first)' : 'Colormap (applies instantly)'
                )}
                <select
                    className="viewer-settings-colormap"
                    value={colormap.value}
                    disabled={colormap.disabled}
                    onChange={(e) => this.applyPatch(host, { colormap: e.target.value })}
                >
                    {colormap.options.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    protected renderShading(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const shading = snapshot.shading;
        if (!shading) {
            return undefined;
        }
        return (
            <label className="viewer-settings-row" key="shading">
                {this.renderRowLabel('layers', 'Shading', 'Shading mode (applies instantly)')}
                <select
                    className="viewer-settings-shading"
                    value={shading.value}
                    onChange={(e) => {
                        if (isViewerShadingMode(e.target.value)) {
                            this.applyPatch(host, { shading: e.target.value });
                        }
                    }}
                >
                    {VIEWER_SHADING_MODES.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                            {mode.label}
                        </option>
                    ))}
                </select>
            </label>
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
                <label className="viewer-settings-row">
                    <Tooltip content="Clip planes: enabled planes apply together (box-section view)" position="right">
                        <span className="viewer-settings-row-label">
                            <input
                                type="checkbox"
                                className="viewer-settings-clip-master"
                                checked={anyClipEnabled(clip.state)}
                                onChange={(e) => this.applyPatch(host, { clip: setAllClipEnabled(clip.state, e.target.checked) })}
                            />
                            Clip
                        </span>
                    </Tooltip>
                </label>
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
                        <input
                            type="range"
                            className="viewer-settings-clip-position"
                            min={0}
                            max={100}
                            step={1}
                            value={Math.round(tab.fraction * 100)}
                            onChange={(e) =>
                                this.applyPatch(host, {
                                    clip: updateAxisClip(clip.state, clip.tab, {
                                        enabled: true,
                                        fraction: parseFloat(e.target.value) / 100
                                    })
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
            <label className="viewer-settings-row" key="opacity">
                {this.renderRowLabel('circle-outline', 'Opacity', 'Material opacity')}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Material opacity" position="top">
                        <input
                            type="range"
                            className="viewer-settings-opacity"
                            min={opacity.min}
                            max={opacity.max}
                            step={opacity.step}
                            value={opacity.value}
                            onChange={(e) => this.applyPatch(host, { opacity: parseFloat(e.target.value) })}
                        />
                    </Tooltip>
                </div>
            </label>
        );
    }

    protected renderStep(host: ViewerSettingsHost, snapshot: ViewerSettingsSnapshot): React.ReactNode {
        const step = snapshot.step;
        if (!step) {
            return undefined;
        }
        return (
            <label className="viewer-settings-row" key="step">
                {this.renderRowLabel('play', `Step ${step.label}`, 'Exodus time step')}
                <div className="viewer-settings-tip-fill">
                    <Tooltip content="Exodus time step" position="top">
                        <input
                            type="range"
                            className="viewer-settings-step"
                            min={0}
                            max={step.count - 1}
                            step={1}
                            value={step.index}
                            onChange={(e) => this.applyPatch(host, { stepIndex: parseInt(e.target.value, 10) })}
                        />
                    </Tooltip>
                </div>
            </label>
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
