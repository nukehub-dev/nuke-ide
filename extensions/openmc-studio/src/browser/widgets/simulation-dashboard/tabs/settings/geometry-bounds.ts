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

import { OpenMCState } from '../../../../../common/openmc-state-schema';

/**
 * Calculate axis-aligned bounding box from geometry surfaces or DAGMC info.
 * Shared by the settings tab (source snapping, entropy mesh) and the volume
 * calculation widget (sampling bounds).
 * @param state - Current OpenMC simulation state.
 * @returns Bounding box with min/max arrays, or null if no geometry.
 */
export function calculateGeometryBounds(state: OpenMCState): { min: number[]; max: number[] } | null {
    // First check for DAGMC geometry bounds
    if (state.settings.dagmcInfo?.boundingBox) {
        console.log('[SnapToGeometry] Using DAGMC bounds:', state.settings.dagmcInfo.boundingBox);
        return {
            min: state.settings.dagmcInfo.boundingBox.min,
            max: state.settings.dagmcInfo.boundingBox.max
        };
    }

    if (state.geometry.surfaces.length === 0) {
        console.log('[SnapToGeometry] No surfaces found');
        return null;
    }

    console.log(`[SnapToGeometry] Calculating bounds from ${state.geometry.surfaces.length} surfaces`);

    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    let validSurfaceCount = 0;

    for (const surface of state.geometry.surfaces) {
        const c = surface.coefficients as any;
        if (!c) {
            console.log(`[SnapToGeometry] Surface ${surface.id}: no coefficients`);
            continue;
        }

        // Handle both object format (new) and array format (old)
        const getValue = (key: string, index: number): number | undefined => {
            if (c[key] !== undefined) return c[key];
            if (Array.isArray(c) && c.length > index) return c[index];
            return undefined;
        };

        switch (surface.type) {
            case 'sphere': {
                // Sphere: x0, y0, z0, r
                const x0 = getValue('x0', 0),
                    y0 = getValue('y0', 1),
                    z0 = getValue('z0', 2),
                    r = getValue('r', 3);
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
                // x - x0 = 0
                const x0 = getValue('x0', 0);
                if (x0 !== undefined) {
                    minX = Math.min(minX, x0);
                    maxX = Math.max(maxX, x0);
                    validSurfaceCount++;
                }
                break;
            }

            case 'y-plane': {
                // y - y0 = 0
                const y0 = getValue('y0', 0);
                if (y0 !== undefined) {
                    minY = Math.min(minY, y0);
                    maxY = Math.max(maxY, y0);
                    validSurfaceCount++;
                }
                break;
            }

            case 'z-plane': {
                // z - z0 = 0
                const z0 = getValue('z0', 0);
                if (z0 !== undefined) {
                    minZ = Math.min(minZ, z0);
                    maxZ = Math.max(maxZ, z0);
                    validSurfaceCount++;
                }
                break;
            }

            case 'x-cylinder': {
                // (y-y0)^2 + (z-z0)^2 = r^2
                const y0 = getValue('y0', 0),
                    z0 = getValue('z0', 1),
                    r = getValue('r', 2);
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
                // (x-x0)^2 + (z-z0)^2 = r^2
                const x0 = getValue('x0', 0),
                    z0 = getValue('z0', 1),
                    r = getValue('r', 2);
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
                // (x-x0)^2 + (y-y0)^2 = r^2
                const x0 = getValue('x0', 0),
                    y0 = getValue('y0', 1),
                    r = getValue('r', 2);
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
                // Cone: x0, y0, z0, r2 (squared radius)
                const x0 = getValue('x0', 0),
                    y0 = getValue('y0', 1),
                    z0 = getValue('z0', 2),
                    r2 = getValue('r2', 3);
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

            default:
                console.log(`[SnapToGeometry] Unknown surface type: ${surface.type}`);
        }
    }

    console.log(
        `[SnapToGeometry] Valid surfaces: ${validSurfaceCount}, Bounds: X[${minX}, ${maxX}], Y[${minY}, ${maxY}], Z[${minZ}, ${maxZ}]`
    );

    // If no valid bounds found, return null
    if (minX === Infinity || minY === Infinity || minZ === Infinity) {
        console.log('[SnapToGeometry] No valid bounds could be calculated');
        return null;
    }

    // Add some default padding if bounds are zero in any dimension
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
