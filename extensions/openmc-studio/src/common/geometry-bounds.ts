// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { OpenMCState } from './openmc-state-schema';

/**
 * Axis-aligned bounding box in 3D.
 * @public
 */
export interface GeometryBounds {
    min: [number, number, number];
    max: [number, number, number];
}

/**
 * Calculate axis-aligned bounding box from geometry surfaces or DAGMC info.
 * Shared by the browser UI (source snapping, entropy mesh, ray source boxes)
 * and the backend validation (source/geometry overlap checks).
 * @param state - Current OpenMC simulation state.
 * @returns Bounding box with min/max arrays, or null if no geometry.
 */
export function calculateGeometryBounds(state: OpenMCState): GeometryBounds | null {
    // Prefer DAGMC geometry bounds when available
    if (state.settings.dagmcInfo?.boundingBox) {
        return {
            min: state.settings.dagmcInfo.boundingBox.min as [number, number, number],
            max: state.settings.dagmcInfo.boundingBox.max as [number, number, number]
        };
    }

    if (state.geometry.surfaces.length === 0) {
        return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let validSurfaceCount = 0;

    for (const surface of state.geometry.surfaces) {
        const c = surface.coefficients as any;
        if (!c) {
            continue;
        }

        // Handle both object format (new) and array format (old)
        const getValue = (key: string, index: number): number | undefined => {
            if (c[key] !== undefined) {
                return c[key];
            }
            if (Array.isArray(c) && c.length > index) {
                return c[index];
            }
            return undefined;
        };

        switch (surface.type) {
            case 'sphere': {
                const x0 = getValue('x0', 0);
                const y0 = getValue('y0', 1);
                const z0 = getValue('z0', 2);
                const r = getValue('r', 3);
                if (x0 !== undefined && y0 !== undefined && z0 !== undefined && r !== undefined) {
                    minX = Math.min(minX, x0 - r);
                    minY = Math.min(minY, y0 - r);
                    minZ = Math.min(minZ, z0 - r);
                    maxX = Math.max(maxX, x0 + r);
                    maxY = Math.max(maxY, y0 + r);
                    maxZ = Math.max(maxZ, z0 + r);
                    validSurfaceCount++;
                }
                break;
            }

            case 'x-plane': {
                const x0 = getValue('x0', 0);
                if (x0 !== undefined) {
                    minX = Math.min(minX, x0);
                    maxX = Math.max(maxX, x0);
                    validSurfaceCount++;
                }
                break;
            }

            case 'y-plane': {
                const y0 = getValue('y0', 0);
                if (y0 !== undefined) {
                    minY = Math.min(minY, y0);
                    maxY = Math.max(maxY, y0);
                    validSurfaceCount++;
                }
                break;
            }

            case 'z-plane': {
                const z0 = getValue('z0', 0);
                if (z0 !== undefined) {
                    minZ = Math.min(minZ, z0);
                    maxZ = Math.max(maxZ, z0);
                    validSurfaceCount++;
                }
                break;
            }

            case 'x-cylinder': {
                const y0 = getValue('y0', 0);
                const z0 = getValue('z0', 1);
                const r = getValue('r', 2);
                if (y0 !== undefined && z0 !== undefined && r !== undefined) {
                    minY = Math.min(minY, y0 - r);
                    minZ = Math.min(minZ, z0 - r);
                    maxY = Math.max(maxY, y0 + r);
                    maxZ = Math.max(maxZ, z0 + r);
                    validSurfaceCount++;
                }
                break;
            }

            case 'y-cylinder': {
                const x0 = getValue('x0', 0);
                const z0 = getValue('z0', 1);
                const r = getValue('r', 2);
                if (x0 !== undefined && z0 !== undefined && r !== undefined) {
                    minX = Math.min(minX, x0 - r);
                    minZ = Math.min(minZ, z0 - r);
                    maxX = Math.max(maxX, x0 + r);
                    maxZ = Math.max(maxZ, z0 + r);
                    validSurfaceCount++;
                }
                break;
            }

            case 'z-cylinder': {
                const x0 = getValue('x0', 0);
                const y0 = getValue('y0', 1);
                const r = getValue('r', 2);
                if (x0 !== undefined && y0 !== undefined && r !== undefined) {
                    minX = Math.min(minX, x0 - r);
                    minY = Math.min(minY, y0 - r);
                    maxX = Math.max(maxX, x0 + r);
                    maxY = Math.max(maxY, y0 + r);
                    validSurfaceCount++;
                }
                break;
            }

            case 'x-cone':
            case 'y-cone':
            case 'z-cone': {
                const x0 = getValue('x0', 0);
                const y0 = getValue('y0', 1);
                const z0 = getValue('z0', 2);
                const r2 = getValue('r2', 3);
                if (x0 !== undefined && y0 !== undefined && z0 !== undefined && r2 !== undefined) {
                    const r = Math.sqrt(Math.abs(r2));
                    minX = Math.min(minX, x0 - r);
                    minY = Math.min(minY, y0 - r);
                    minZ = Math.min(minZ, z0 - r);
                    maxX = Math.max(maxX, x0 + r);
                    maxY = Math.max(maxY, y0 + r);
                    maxZ = Math.max(maxZ, z0 + r);
                    validSurfaceCount++;
                }
                break;
            }
        }
    }

    if (minX === Infinity || minY === Infinity || minZ === Infinity) {
        return null;
    }

    // Add padding if bounds are degenerate in any dimension
    if (maxX - minX < 0.001) {
        maxX += 1;
        minX -= 1;
    }
    if (maxY - minY < 0.001) {
        maxY += 1;
        minY -= 1;
    }
    if (maxZ - minZ < 0.001) {
        maxZ += 1;
        minZ -= 1;
    }

    return {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ]
    };
}

/**
 * Test whether an axis-aligned box overlaps a geometry bounding box.
 * Touching at an edge counts as overlap.
 * @param box - Source box lower-left / upper-right.
 * @param bounds - Geometry bounding box.
 * @returns True if the boxes overlap.
 */
export function boxOverlapsBounds(
    box: { lowerLeft: [number, number, number]; upperRight: [number, number, number] },
    bounds: GeometryBounds
): boolean {
    return (
        box.upperRight[0] >= bounds.min[0] &&
        box.lowerLeft[0] <= bounds.max[0] &&
        box.upperRight[1] >= bounds.min[1] &&
        box.lowerLeft[1] <= bounds.max[1] &&
        box.upperRight[2] >= bounds.min[2] &&
        box.lowerLeft[2] <= bounds.max[2]
    );
}

/**
 * Test whether a point lies inside a geometry bounding box.
 * Points on the boundary count as inside.
 * @param point - Point coordinates.
 * @param bounds - Geometry bounding box.
 * @returns True if the point is inside or on the boundary.
 */
export function pointInBounds(point: [number, number, number], bounds: GeometryBounds): boolean {
    return (
        point[0] >= bounds.min[0] &&
        point[0] <= bounds.max[0] &&
        point[1] >= bounds.min[1] &&
        point[1] <= bounds.max[1] &&
        point[2] >= bounds.min[2] &&
        point[2] <= bounds.max[2]
    );
}
