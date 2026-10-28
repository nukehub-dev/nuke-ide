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
import { NukeSlider, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { VIEWER_SHADING_MODES, type ViewerShadingMode } from '../../../viewer-core/shading-mode';
import { VIEWER_SHADING_MENU_ICONS } from '../../../viewer-core/viewer-context-menu';
import { CLIP_AXES, type AxisClipState, type ClipAxis, type ClipPlanesState } from '../../../viewer-core/clip-plane';
import {
    clampNavPopoverPosition,
    NAV_POPOVER_ANCHOR_BOTTOM_PX,
    NAV_POPOVER_ANCHOR_RIGHT_PX
} from '../../../viewer-core/viewer-nav-popover';

/**
 * Quick-access popovers riding the shared `ViewerNavBar` as `children` for
 * the nuke-visualizer native viewers (native VTK + DAGMC).
 *
 * CAD anchored-popover parity: the shared bar's core action set
 * (`ViewerNavAction`: ISO/T/F/R + fit + zoom) stays untouched — tool buttons
 * on the same bar open small floating cards (a Clip card with X/Y/Z + Flip
 * + Offset slider, a Shading card with a mode list), anchored above the
 * cluster. No distant panel, no inline rows.
 *
 * Every control is props-only: the host widget owns the state and routes
 * callbacks onto its EXISTING setters (`applyProps` clip/shading paths, the
 * DAGMC visibility setters, the widget-owned `clipTab`, the per-widget
 * `cameraLinked` flag) — the same calls the Viewer Settings sidebar and the
 * right-click menu make. No new viewer state; the sidebar remains
 * authoritative and these popovers are stateless mirrors of it.
 *
 * Dismissal matches CAD: toggle on re-click (host slot), Escape and a
 * pointer-down outside the bar + card close the open card (host window
 * listeners), picking a shading mode closes its card while clip sliders
 * stay open for repeated drags. The cards never take focus on open, so
 * canvas keyboard shortcuts keep working.
 */

function navButtonClass(active: boolean): string {
    return `theia-button secondary nuke-viewer-nav-bar-button${active ? ' active' : ''}`;
}

/**
 * Anchored popover shell (visualizer-local reimplementation of CAD's
 * `.cad-viewport-popover` card — see the extraction rationale in the
 * module docs of the host widgets).
 *
 * First paint uses the CAD-parity anchor (`right`/`bottom` offsets above
 * the cluster); a layout effect then measures the card against its
 * positioned container and clamps the origin inside it
 * (`clampNavPopoverPosition`), so narrow viewports never clip the card.
 */
export interface ViewerNavPopoverShellProps {
    readonly anchorRight?: number;
    readonly anchorBottom?: number;
    readonly popoverRef?: (element: HTMLDivElement | null) => void;
    readonly children?: React.ReactNode;
}

export const ViewerNavPopoverShell: React.FC<ViewerNavPopoverShellProps> = ({
    anchorRight = NAV_POPOVER_ANCHOR_RIGHT_PX,
    anchorBottom = NAV_POPOVER_ANCHOR_BOTTOM_PX,
    popoverRef,
    children
}) => {
    const innerRef = React.useRef<HTMLDivElement>(null);
    const [clamped, setClamped] = React.useState<{ left: number; top: number } | undefined>(undefined);
    React.useLayoutEffect(() => {
        const element = innerRef.current;
        // The positioned viewarea container (the popover is absolutely
        // positioned, so its offset parent is the clamp viewport).
        const container = element?.offsetParent as HTMLElement | null;
        if (!element || !container) {
            return;
        }
        setClamped(
            clampNavPopoverPosition(
                { width: element.offsetWidth, height: element.offsetHeight },
                { width: container.clientWidth, height: container.clientHeight },
                anchorRight,
                anchorBottom
            )
        );
    }, [anchorRight, anchorBottom]);
    return (
        <div
            ref={(element) => {
                innerRef.current = element;
                popoverRef?.(element);
            }}
            className="viewer-nav-popover"
            role="dialog"
            style={clamped !== undefined ? { left: clamped.left, top: clamped.top } : { right: anchorRight, bottom: anchorBottom }}
        >
            {children}
        </div>
    );
};

/** Clip popover trigger (layers icon, lit while any plane is enabled). */
export interface ViewerClipTriggerProps {
    readonly clipEnabled: boolean;
    readonly open: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
}

export const ViewerClipTrigger: React.FC<ViewerClipTriggerProps> = ({ clipEnabled, open, disabled, onToggle }) => (
    <Tooltip
        content={clipEnabled ? 'Clip planes on — click for X/Y/Z + offset' : 'Clip planes off — click for X/Y/Z + offset'}
        position="left"
    >
        <button
            className={`${navButtonClass(clipEnabled)} viewer-nav-clip-trigger`}
            disabled={disabled}
            onClick={onToggle}
            aria-pressed={clipEnabled}
            aria-expanded={open}
        >
            <span className="codicon codicon-layers" />
        </button>
    </Tooltip>
);

/**
 * Clip quick-access card: X/Y/Z axis tabs (the widget-owned tab the sidebar
 * shows, so both stay in sync), an enable toggle + Flip for the tab axis,
 * and an Offset slider with a % readout.
 *
 * Flip/offset adjustments enable the tab plane (the geometry-native header
 * grammar: moving the cut implies wanting the cut), so opening the card and
 * dragging Offset clips the canvas with no extra step.
 */
export interface ViewerClipPopoverProps {
    readonly clip: ClipPlanesState;
    readonly tab: ClipAxis;
    readonly disabled?: boolean;
    readonly onTabChange: (axis: ClipAxis) => void;
    readonly onAxisChange: (axis: ClipAxis, patch: Partial<AxisClipState>) => void;
}

export const ViewerClipPopover: React.FC<ViewerClipPopoverProps> = ({ clip, tab, disabled, onTabChange, onAxisChange }) => {
    const entry = clip[tab];
    return (
        <div className="viewer-nav-clip-popover">
            <div className="viewer-nav-clip-row">
                {CLIP_AXES.map((axis) => (
                    <Tooltip key={axis} content={`${axis} plane`} position="left">
                        <button
                            className={`viewer-nav-clip-axis${axis === tab ? ' active' : ''}`}
                            disabled={disabled}
                            onClick={() => onTabChange(axis)}
                            aria-pressed={axis === tab}
                        >
                            {axis}
                        </button>
                    </Tooltip>
                ))}
                <Tooltip content={entry.enabled ? `Disable the ${tab} plane` : `Enable the ${tab} plane`} position="top">
                    <button
                        className={`viewer-nav-clip-flip${entry.enabled ? ' active' : ''}`}
                        disabled={disabled}
                        onClick={() => onAxisChange(tab, { enabled: !entry.enabled })}
                        aria-pressed={entry.enabled}
                    >
                        {entry.enabled ? 'On' : 'Off'}
                    </button>
                </Tooltip>
                <Tooltip content={`Keep the other ${tab} half (enables the plane)`} position="top">
                    <button
                        className={`viewer-nav-clip-flip${entry.invert ? ' active' : ''}`}
                        disabled={disabled}
                        onClick={() => onAxisChange(tab, { enabled: true, invert: !entry.invert })}
                        aria-pressed={entry.invert}
                    >
                        Flip
                    </button>
                </Tooltip>
            </div>
            <div className="viewer-nav-clip-slider-row">
                Offset
                <NukeSlider
                    className="viewer-nav-clip-offset"
                    ariaLabel="Clip offset"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(entry.fraction * 100)}
                    disabled={disabled}
                    onChange={(value) => onAxisChange(tab, { enabled: true, fraction: value / 100 })}
                />
                <span>{Math.round(entry.fraction * 100)}%</span>
            </div>
        </div>
    );
};

/** Shading popover trigger (current mode icon, lit while not shaded). */
export interface ViewerShadingTriggerProps {
    readonly shading: ViewerShadingMode;
    readonly open: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
}

export const ViewerShadingTrigger: React.FC<ViewerShadingTriggerProps> = ({ shading, disabled, open, onToggle }) => {
    const current = VIEWER_SHADING_MODES.find((mode) => mode.id === shading) ?? VIEWER_SHADING_MODES[0];
    return (
        <Tooltip content={`Shading: ${current.label} — click for the mode list`} position="left">
            <button
                className={`${navButtonClass(shading !== 'shaded')} viewer-nav-shading-trigger`}
                disabled={disabled}
                onClick={onToggle}
                aria-expanded={open}
            >
                <span className={`codicon ${VIEWER_SHADING_MENU_ICONS[shading]}`} />
            </button>
        </Tooltip>
    );
};

/**
 * Shading quick-access card: the sidebar mode list (same order, same
 * icons) with a check on the active mode. Picking a mode applies it
 * through the existing shading setter and closes the card (CAD parity).
 */
export interface ViewerShadingPopoverProps {
    readonly shading: ViewerShadingMode;
    readonly disabled?: boolean;
    readonly onSelect: (mode: ViewerShadingMode) => void;
}

export const ViewerShadingPopover: React.FC<ViewerShadingPopoverProps> = ({ shading, disabled, onSelect }) => (
    <div className="viewer-nav-shading-popover">
        {VIEWER_SHADING_MODES.map((mode) => (
            <Tooltip key={mode.id} content={mode.label} position="left">
                <button
                    className={`viewer-nav-shading-item${mode.id === shading ? ' active' : ''}`}
                    disabled={disabled}
                    onClick={() => onSelect(mode.id)}
                >
                    <span className={`codicon ${VIEWER_SHADING_MENU_ICONS[mode.id]}`} />
                    <span className="viewer-nav-shading-label">{mode.label}</span>
                    {mode.id === shading && <span className="codicon codicon-check" />}
                </button>
            </Tooltip>
        ))}
    </div>
);

/**
 * Camera-link toggle (link icon, lit while linked): opt-in camera sync with
 * other views of the same file. Props-only like every other extra — the host
 * widget owns the per-widget flag (default off) and the bus publish/apply
 * wiring; only the camera follows, display settings never sync.
 */
export interface LinkCamerasTriggerProps {
    readonly linked: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
}

export const LinkCamerasTrigger: React.FC<LinkCamerasTriggerProps> = ({ linked, disabled, onToggle }) => (
    <Tooltip content={linked ? 'Cameras linked — click to unlink this view' : 'Link cameras with other views of this file'} position="left">
        <button
            className={`${navButtonClass(linked)} viewer-nav-link-cameras`}
            disabled={disabled}
            onClick={onToggle}
            aria-pressed={linked}
        >
            <span className="codicon codicon-link" />
        </button>
    </Tooltip>
);

/**
 * Find Data trigger: opens the transient query dialog. Lit while a
 * selection is active so the canvas highlight is discoverable.
 */
export interface FindDataTriggerProps {
    readonly active: boolean;
    readonly disabled?: boolean;
    readonly onClick: () => void;
}

export const FindDataTrigger: React.FC<FindDataTriggerProps> = ({ active, disabled, onClick }) => (
    <Tooltip content={active ? 'Find Data (selection active)' : 'Find Data by value, id, or name'} position="left">
        <button className={`${navButtonClass(active)} viewer-nav-find-data`} disabled={disabled} onClick={onClick} aria-pressed={active}>
            <span className="codicon codicon-search" />
        </button>
    </Tooltip>
);

/**
 * Probe trigger: opens the generic point/line probe card next to the
 * canvas. Props-only like every other extra — the host widget owns the dialog
 * and the picking session.
 */
export interface ProbeTriggerProps {
    readonly active: boolean;
    readonly disabled?: boolean;
    readonly onClick: () => void;
}

export const ProbeTrigger: React.FC<ProbeTriggerProps> = ({ active, disabled, onClick }) => (
    <Tooltip content="Probe point values and line profiles" position="left">
        <button className={`${navButtonClass(active)} viewer-nav-probe`} disabled={disabled} onClick={onClick} aria-pressed={active}>
            <span className="codicon codicon-pulse" />
        </button>
    </Tooltip>
);

/**
 * DAGMC-only volume quick actions over the widget-owned canvas selection:
 * Exclude hides the selected volume, Isolate hides everything else (both
 * through the existing visibility setters; Show all in the DAGMC Outline
 * sidebar resets). Disabled until a volume is selected.
 *
 * These stay direct buttons (no popover): they act on the transient canvas
 * selection, not on persistent view-state modes, so CAD has no popover
 * analog for them.
 */
export interface DagmcIsolateActionsProps {
    readonly selectedVolumeId: number | null;
    readonly disabled?: boolean;
    readonly onExclude: () => void;
    readonly onIsolate: () => void;
}

export const DagmcIsolateActions: React.FC<DagmcIsolateActionsProps> = ({ selectedVolumeId, disabled, onExclude, onIsolate }) => {
    const hasSelection = selectedVolumeId !== null;
    return (
        <>
            <Tooltip
                content={
                    hasSelection
                        ? `Exclude volume ${selectedVolumeId} (hide it)`
                        : 'Exclude: select a volume in the canvas or outline first'
                }
                position="left"
            >
                <button className={navButtonClass(false)} disabled={disabled || !hasSelection} onClick={onExclude}>
                    <span className="codicon codicon-eye-closed" />
                </button>
            </Tooltip>
            <Tooltip
                content={
                    hasSelection
                        ? `Isolate volume ${selectedVolumeId} (hide everything else)`
                        : 'Isolate: select a volume in the canvas or outline first'
                }
                position="left"
            >
                <button className={navButtonClass(false)} disabled={disabled || !hasSelection} onClick={onIsolate}>
                    <span className="codicon codicon-eye" />
                </button>
            </Tooltip>
        </>
    );
};

/**
 * Screenshot + reload direct buttons (no popover): the old two-button viewer
 * header folded into the nav bar so the header row is gone entirely. Same
 * actions, same disabled logic — the canvas ViewBadge stays the single
 * file-name surface.
 */
export interface ViewerFileActionsProps {
    readonly disabled?: boolean;
    readonly onScreenshot: () => void;
    readonly onReload: () => void;
    /** Optional screenshot options popover rendered beside the one-click PNG button. */
    readonly exportMenu?: React.ReactNode;
}

export const ViewerFileActions: React.FC<ViewerFileActionsProps> = ({ disabled, onScreenshot, onReload, exportMenu }) => (
    <>
        <Tooltip content="Download PNG screenshot" position="left">
            <button className={`${navButtonClass(false)} viewer-nav-screenshot`} disabled={disabled} onClick={onScreenshot}>
                <span className="codicon codicon-device-camera" />
            </button>
        </Tooltip>
        {exportMenu}
        <Tooltip content="Reload file" position="left">
            <button className={`${navButtonClass(false)} viewer-nav-reload`} disabled={disabled} onClick={onReload}>
                <span className="codicon codicon-refresh" />
            </button>
        </Tooltip>
    </>
);
