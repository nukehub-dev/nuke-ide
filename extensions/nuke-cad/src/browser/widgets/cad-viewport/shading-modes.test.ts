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

import { describe, expect, it } from 'vitest';
import {
    clampGhostOpacity,
    DEFAULT_GHOST_OPACITY,
    GHOST_OPACITY_MAX,
    GHOST_OPACITY_MIN,
    meshShadingFlags,
    SHADING_MODES
} from './shading-modes';

const OPAQUE = { faceVisible: true, wireframe: false, transparent: false, opacity: 1, depthWrite: true };

describe('shading-modes', () => {
    it('lists all four modes in popover order', () => {
        expect(SHADING_MODES.map((mode) => mode.id)).toEqual(['shaded', 'shadedWireframe', 'edgesOnly', 'xray']);
    });

    it('renders shaded faces opaque with depth writes', () => {
        expect(meshShadingFlags('shaded', DEFAULT_GHOST_OPACITY)).toEqual(OPAQUE);
    });

    it('keeps faces visible and switches on triangle wireframe for shadedWireframe', () => {
        expect(meshShadingFlags('shadedWireframe', DEFAULT_GHOST_OPACITY)).toEqual({ ...OPAQUE, wireframe: true });
    });

    it('hides face meshes but leaves their materials opaque for edgesOnly', () => {
        expect(meshShadingFlags('edgesOnly', DEFAULT_GHOST_OPACITY)).toEqual({ ...OPAQUE, faceVisible: false });
    });

    it('ghosts faces without depth writes for xray at the requested opacity', () => {
        expect(meshShadingFlags('xray', 0.4)).toEqual({
            faceVisible: true,
            wireframe: false,
            transparent: true,
            opacity: 0.4,
            depthWrite: false
        });
    });

    it('clamps an out-of-range opacity passed to xray flags', () => {
        expect(meshShadingFlags('xray', 0).opacity).toBe(GHOST_OPACITY_MIN);
        expect(meshShadingFlags('xray', 5).opacity).toBe(GHOST_OPACITY_MAX);
    });

    it('clamps ghost opacity into the slider range', () => {
        expect(clampGhostOpacity(-1)).toBe(GHOST_OPACITY_MIN);
        expect(clampGhostOpacity(2)).toBe(GHOST_OPACITY_MAX);
        expect(clampGhostOpacity(0.35)).toBe(0.35);
        expect(GHOST_OPACITY_MIN).toBeLessThan(DEFAULT_GHOST_OPACITY);
        expect(DEFAULT_GHOST_OPACITY).toBeLessThan(GHOST_OPACITY_MAX);
    });
});
