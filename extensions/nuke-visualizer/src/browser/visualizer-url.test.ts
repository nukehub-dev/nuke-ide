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

/**
 * Tests for {@link toProxiedVisualizerUrl}.
 *
 * In NukeLab deployments the IDE is served under a user-specific path prefix
 * (e.g. /user/tahmid/my/). The proxied visualizer URL must stay under that
 * prefix so Traefik routes it to the same container and the NukeLab service
 * worker bypasses the request instead of serving the SPA shell.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { toProxiedVisualizerUrl } from './visualizer-url';

describe('toProxiedVisualizerUrl', () => {
    const originalSelf = globalThis.self;

    afterEach(() => {
        vi.stubGlobal('self', originalSelf);
    });

    it('returns the proxied URL under the current page path prefix', () => {
        vi.stubGlobal('self', {
            location: {
                protocol: 'https:',
                host: 'nukehub.example.com',
                pathname: '/user/tahmid/my/',
                search: ''
            }
        });

        expect(toProxiedVisualizerUrl('http://127.0.0.1:8765')).toBe('https://nukehub.example.com/user/tahmid/my/visualizer/8765/');
    });

    it('works when the page path has no trailing slash', () => {
        vi.stubGlobal('self', {
            location: {
                protocol: 'https:',
                host: 'nukehub.example.com',
                pathname: '/user/tahmid/my',
                search: ''
            }
        });

        expect(toProxiedVisualizerUrl('http://127.0.0.1:8765')).toBe('https://nukehub.example.com/user/tahmid/my/visualizer/8765/');
    });

    it('works at the site root', () => {
        vi.stubGlobal('self', {
            location: {
                protocol: 'http:',
                host: 'localhost:3000',
                pathname: '/',
                search: ''
            }
        });

        expect(toProxiedVisualizerUrl('http://127.0.0.1:8765')).toBe('http://localhost:3000/visualizer/8765/');
    });

    it('leaves non-loopback URLs unchanged', () => {
        vi.stubGlobal('self', {
            location: {
                protocol: 'https:',
                host: 'nukehub.example.com',
                pathname: '/user/tahmid/my/',
                search: ''
            }
        });

        expect(toProxiedVisualizerUrl('https://example.com/viz')).toBe('https://example.com/viz');
    });
});
