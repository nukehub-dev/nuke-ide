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

import * as React from '@theia/core/shared/react';
import { Tooltip } from './tooltip';
import {
    VIEW_CUBE_AXES,
    VIEW_CUBE_BOX,
    VIEW_CUBE_CENTER,
    VIEW_CUBE_IDENTITY,
    VIEW_CUBE_KNOB,
    VIEW_CUBE_RADIUS,
    projectViewCube,
    viewCubeAxisFamily,
    viewCubeKnobLabel,
    viewCubeSnapLabel,
    type ViewCubeOrientation,
    type ViewCubeVector
} from './view-cube-math';

/**
 * Shared orientation cube for the 3D viewers (nuke-cad viewport and
 * nuke-visualizer native viewers), adopting the CAD labeled-triad look:
 * three spokes with labeled axis knobs (+X/+Y/+Z filled, −X/−Y/−Z hollow)
 * in a fixed-size overlay box.
 *
 * Same overlay pattern as `ViewerNavBar` (absolute overlay on the 3D
 * viewarea, Nuke tooltips) but imperative: spoke endpoints and knob
 * positions are written straight to the DOM through {@link ViewCubeHandle}
 * on every controls change — never React state, so orbiting never
 * re-renders. The host widget calls the handle from its render-on-demand
 * repaint and hides the cube by unmounting it while no dataset is loaded.
 * Clicking a knob snaps the standard view through the host's orbit handle
 * (`onSnap` receives the model-space direction triple; the Y-up / Z-up
 * convention lives with the host, never here). Knob stacking follows the
 * back-to-front paint order from `view-cube-math.ts`, so the front-most
 * axis always wins overlapping screen regions. Styling lives in
 * `view-cube.css` (`.nuke-view-cube`); overlay placement (top-right
 * offsets) stays with the host extension, whose toolbar chrome differs.
 */

/** Imperative cube driver owned by the host widget (no React state involved). */
export interface ViewCubeHandle {
    /** Re-project the six axes for a new camera orientation (direct DOM writes). */
    update: (orientation: ViewCubeOrientation) => void;
}

export interface ViewCubeProps {
    /** Snap callback: the host drives its orbit handle with the direction triple. */
    readonly onSnap: (direction: ViewCubeVector) => void;
}

export const ViewCube = React.forwardRef<ViewCubeHandle, ViewCubeProps>(({ onSnap }, ref) => {
    const svgRef = React.useRef<SVGSVGElement | null>(null);
    const lineRefs = React.useRef<Array<SVGLineElement | null>>([]);
    const knobRefs = React.useRef<Array<HTMLDivElement | null>>([]);

    const onSnapRef = React.useRef(onSnap);
    onSnapRef.current = onSnap;

    React.useImperativeHandle(
        ref,
        () => ({
            update: (orientation) => {
                const projections = projectViewCube(orientation);
                const svg = svgRef.current;
                // Projections arrive back-to-front; appending in order keeps
                // the SVG paint order (and the knob z-index below) in sync.
                const lineIndexByAxis = new Map(VIEW_CUBE_AXES.map((axis, index) => [axis.id, index]));
                for (const projection of projections) {
                    const index = lineIndexByAxis.get(projection.axis) ?? -1;
                    if (index < 0) {
                        continue;
                    }
                    if (projection.positive) {
                        const line = lineRefs.current[index];
                        if (line) {
                            line.setAttribute('x2', String(VIEW_CUBE_CENTER + projection.x * VIEW_CUBE_RADIUS));
                            line.setAttribute('y2', String(VIEW_CUBE_CENTER - projection.y * VIEW_CUBE_RADIUS));
                            line.setAttribute('opacity', projection.depth >= 0 ? '1' : '0.4');
                            svg?.appendChild(line);
                        }
                    }
                    const knob = knobRefs.current[index];
                    if (knob) {
                        knob.style.transform = `translate(${projection.x * VIEW_CUBE_RADIUS}px, ${-projection.y * VIEW_CUBE_RADIUS}px)`;
                        knob.style.zIndex = String(Math.round((projection.depth + 1) * 10));
                        knob.style.opacity = projection.depth >= 0 ? '1' : '0.55';
                    }
                }
            }
        }),
        []
    );

    // Initial (pre-first-update) layout from the identity orientation: plain
    // derived values, not React state, so the first paint is already sane.
    const initialById = new Map(projectViewCube(VIEW_CUBE_IDENTITY).map((projection) => [projection.axis, projection]));
    return (
        <div className="nuke-view-cube" role="toolbar" aria-label="Orientation cube">
            <svg ref={svgRef} className="nuke-view-cube-spokes" width={VIEW_CUBE_BOX} height={VIEW_CUBE_BOX} aria-hidden={true}>
                {VIEW_CUBE_AXES.filter((axis) => !axis.id.startsWith('-')).map((axis) => {
                    const index = VIEW_CUBE_AXES.indexOf(axis);
                    const initial = initialById.get(axis.id);
                    return (
                        <line
                            key={axis.id}
                            ref={(element) => {
                                lineRefs.current[index] = element;
                            }}
                            x1={VIEW_CUBE_CENTER}
                            y1={VIEW_CUBE_CENTER}
                            x2={VIEW_CUBE_CENTER + (initial?.x ?? 0) * VIEW_CUBE_RADIUS}
                            y2={VIEW_CUBE_CENTER - (initial?.y ?? 0) * VIEW_CUBE_RADIUS}
                            className="nuke-view-cube-spoke"
                            opacity={(initial?.depth ?? 0) >= 0 ? 1 : 0.4}
                        />
                    );
                })}
            </svg>
            {VIEW_CUBE_AXES.map((axis, index) => {
                const initial = initialById.get(axis.id);
                return (
                    <div
                        key={axis.id}
                        ref={(element) => {
                            knobRefs.current[index] = element;
                        }}
                        className="nuke-view-cube-knob-slot"
                        style={{
                            // Definite hit box centered on the overlay center: the
                            // translate below moves the whole box so its center
                            // lands on the spoke endpoint (a 0x0 slot lets the
                            // Tooltip span collapse and shrink the knob to a
                            // sliver). The knob button fills the box, so it owns
                            // no centering transform of its own.
                            width: VIEW_CUBE_KNOB,
                            height: VIEW_CUBE_KNOB,
                            left: VIEW_CUBE_CENTER - VIEW_CUBE_KNOB / 2,
                            top: VIEW_CUBE_CENTER - VIEW_CUBE_KNOB / 2,
                            transform: `translate(${(initial?.x ?? 0) * VIEW_CUBE_RADIUS}px, ${-(initial?.y ?? 0) * VIEW_CUBE_RADIUS}px)`,
                            zIndex: Math.round(((initial?.depth ?? 0) + 1) * 10),
                            opacity: (initial?.depth ?? 0) >= 0 ? 1 : 0.55
                        }}
                    >
                        <Tooltip content={viewCubeSnapLabel(axis.id)} position="left">
                            <button
                                className={`nuke-view-cube-knob nuke-view-cube-axis-${viewCubeAxisFamily(axis.id)}${axis.id.startsWith('-') ? ' nuke-view-cube-knob-negative' : ''}`}
                                onClick={() => onSnapRef.current(axis.direction)}
                            >
                                {viewCubeKnobLabel(axis.id)}
                            </button>
                        </Tooltip>
                    </div>
                );
            })}
        </div>
    );
});
