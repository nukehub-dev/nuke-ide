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

import * as THREE from 'three';

/**
 * Shared round point sprite for native point clouds (tally overlays and
 * slices, collision tracks, sources, DAGMC/exodus points): plain
 * `PointsMaterial` renders square pixels, which reads dated next to the
 * shaded surfaces. A white radial disc texture (modulated by the vertex
 * colors, so mapping is unaffected) renders round soft points instead.
 *
 * Pure except for the canvas paint itself; degrades to `undefined` (square
 * points, as before) wherever no 2D canvas exists — including the node
 * vitest profile.
 */

/** Sprite canvas edge length in pixels. */
export const POINT_SPRITE_SIZE = 64;

/**
 * Gradient stops of the disc, outermost-first contract: fully opaque out
 * to `solidRadius`, then a linear fade to transparent at the rim for
 * anti-aliased edges.
 */
export function pointSpriteStops(): readonly (readonly [offset: number, color: string])[] {
    return [
        [0, 'rgba(255,255,255,1)'],
        [0.55, 'rgba(255,255,255,1)'],
        [1, 'rgba(255,255,255,0)']
    ];
}

let cachedSprite: THREE.Texture | undefined;
let spriteAttempted = false;

/** Module-cached disc texture, or undefined when no canvas is available. */
export function getPointSpriteTexture(): THREE.Texture | undefined {
    if (spriteAttempted) {
        return cachedSprite;
    }
    spriteAttempted = true;
    if (typeof document === 'undefined') {
        return undefined;
    }
    const canvas = document.createElement('canvas');
    canvas.width = POINT_SPRITE_SIZE;
    canvas.height = POINT_SPRITE_SIZE;
    const context = canvas.getContext('2d');
    if (!context) {
        return undefined;
    }
    const radius = POINT_SPRITE_SIZE / 2;
    const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
    for (const [offset, color] of pointSpriteStops()) {
        gradient.addColorStop(offset, color);
    }
    context.fillStyle = gradient;
    context.fillRect(0, 0, POINT_SPRITE_SIZE, POINT_SPRITE_SIZE);
    cachedSprite = new THREE.CanvasTexture(canvas);
    return cachedSprite;
}
