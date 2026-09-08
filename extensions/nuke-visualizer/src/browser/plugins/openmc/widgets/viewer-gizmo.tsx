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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    DEFAULT_GIZMO_POSE,
    GIZMO_AXES,
    GIZMO_VIEW_DIRECTIONS,
    VIEWER_GIZMO_BOX,
    VIEWER_GIZMO_CENTER,
    VIEWER_GIZMO_KNOB,
    VIEWER_GIZMO_RADIUS,
    projectGizmoAxes,
    type GizmoCameraPose,
    type GizmoVector
} from '../../../viewer-core/orientation-gizmo';

/**
 * CAD-style orientation gizmo for the native 3D viewers, mounted by the
 * native VTK viewer (and its subclasses, which inherit the chrome) and the
 * DAGMC viewer.
 *
 * Same overlay pattern as `ViewerNavCluster` (absolute overlay on the 3D
 * viewarea, Nuke tooltips) but imperative: spoke endpoints and knob positions
 * are written straight to the DOM through {@link ViewerGizmoHandle} on every
 * controls change — never React state, so orbiting never re-renders. The host
 * widget calls the handle from its render-on-demand repaint (the OrbitControls
 * `onChange` hook) and hides the gizmo by unmounting it while no dataset is
 * loaded. Clicking a knob snaps the standard view through the host's orbit
 * handle (`setViewDirection`); knob stacking follows the octant rule from
 * `viewer-core/orientation-gizmo.ts` (highest `facing` on top), so the
 * front-most axis always wins overlapping screen regions. Styling lives in
 * `output-viewer.css` (`.viewer-gizmo`).
 */

/** Imperative gizmo driver owned by the host widget (no React state involved). */
export interface ViewerGizmoHandle {
    /** Re-project the six axes for a new camera pose (direct DOM writes). */
    update: (pose: GizmoCameraPose) => void;
}

export interface ViewerGizmoProps {
    /** Snap callback: the host drives its orbit handle's `setViewDirection`. */
    readonly onSnap: (direction: GizmoVector) => void;
}

/** Spoke color per axis family (CAD convention: X red, Y green, Z blue). */
const GIZMO_AXIS_COLORS: Record<string, string> = { X: '#d45a5a', Y: '#5aa862', Z: '#5a8fd4' };

function axisFamily(axis: string): string {
    return axis.replace('-', '');
}

function snapLabel(axis: string): string {
    return `Snap to ${axis} view`;
}

export const ViewerGizmo = React.forwardRef<ViewerGizmoHandle, ViewerGizmoProps>(({ onSnap }, ref) => {
    const svgRef = React.useRef<SVGSVGElement | null>(null);
    const lineRefs = React.useRef<Array<SVGLineElement | null>>([]);
    const knobRefs = React.useRef<Array<HTMLDivElement | null>>([]);

    React.useImperativeHandle(
        ref,
        () => ({
            update: (pose) => {
                const projections = projectGizmoAxes(pose);
                const svg = svgRef.current;
                const order = projections.map((projection, index) => index);
                order.sort((a, b) => projections[a].facing - projections[b].facing);
                for (const index of order) {
                    const projection = projections[index];
                    const line = lineRefs.current[index];
                    if (line) {
                        line.setAttribute('x2', String(VIEWER_GIZMO_CENTER + projection.x * VIEWER_GIZMO_RADIUS));
                        line.setAttribute('y2', String(VIEWER_GIZMO_CENTER - projection.y * VIEWER_GIZMO_RADIUS));
                        line.setAttribute('opacity', projection.facing >= 0 ? '1' : '0.4');
                        svg?.appendChild(line);
                    }
                    const knob = knobRefs.current[index];
                    if (knob) {
                        knob.style.transform = `translate(${projection.x * VIEWER_GIZMO_RADIUS}px, ${-projection.y * VIEWER_GIZMO_RADIUS}px)`;
                        knob.style.zIndex = String(Math.round((projection.facing + 1) * 10));
                        knob.style.opacity = projection.facing >= 0 ? '1' : '0.55';
                    }
                }
            }
        }),
        []
    );

    // Initial (pre-first-update) layout from the default iso pose: plain
    // derived values, not React state, so the first paint is already sane.
    const initial = projectGizmoAxes(DEFAULT_GIZMO_POSE);
    return (
        <div className="viewer-gizmo" role="toolbar" aria-label="Orientation gizmo">
            <svg ref={svgRef} className="viewer-gizmo-spokes" width={VIEWER_GIZMO_BOX} height={VIEWER_GIZMO_BOX} aria-hidden={true}>
                {GIZMO_AXES.map((axis, index) => (
                    <line
                        key={axis.id}
                        ref={(element) => {
                            lineRefs.current[index] = element;
                        }}
                        x1={VIEWER_GIZMO_CENTER}
                        y1={VIEWER_GIZMO_CENTER}
                        x2={VIEWER_GIZMO_CENTER + initial[index].x * VIEWER_GIZMO_RADIUS}
                        y2={VIEWER_GIZMO_CENTER - initial[index].y * VIEWER_GIZMO_RADIUS}
                        stroke={GIZMO_AXIS_COLORS[axisFamily(axis.id)]}
                        strokeWidth={2}
                        opacity={initial[index].facing >= 0 ? 1 : 0.4}
                    />
                ))}
            </svg>
            {GIZMO_AXES.map((axis, index) => (
                <div
                    key={axis.id}
                    ref={(element) => {
                        knobRefs.current[index] = element;
                    }}
                    className="viewer-gizmo-knob-slot"
                    style={{
                        // Definite hit box centered on the overlay center: the
                        // translate below moves the whole box so its center
                        // lands on the spoke endpoint (a 0x0 slot lets the
                        // Tooltip span collapse and shrink the knob to a
                        // sliver). The knob button fills the box, so it owns
                        // no centering transform of its own.
                        width: VIEWER_GIZMO_KNOB,
                        height: VIEWER_GIZMO_KNOB,
                        left: VIEWER_GIZMO_CENTER - VIEWER_GIZMO_KNOB / 2,
                        top: VIEWER_GIZMO_CENTER - VIEWER_GIZMO_KNOB / 2,
                        transform: `translate(${initial[index].x * VIEWER_GIZMO_RADIUS}px, ${-initial[index].y * VIEWER_GIZMO_RADIUS}px)`,
                        zIndex: Math.round((initial[index].facing + 1) * 10),
                        opacity: initial[index].facing >= 0 ? 1 : 0.55
                    }}
                >
                    <Tooltip content={snapLabel(axis.id)} position="left">
                        <button
                            className={`viewer-gizmo-knob viewer-gizmo-axis-${axisFamily(axis.id).toLowerCase()}`}
                            onClick={() => onSnap(GIZMO_VIEW_DIRECTIONS[axis.id])}
                        >
                            {axis.id}
                        </button>
                    </Tooltip>
                </div>
            ))}
        </div>
    );
});
