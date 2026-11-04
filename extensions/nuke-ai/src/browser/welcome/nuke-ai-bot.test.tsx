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

import { describe, expect, it } from 'vitest';
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeBotLookOffset, NukeAiBot, NUKE_AI_BOT_MAX_LOOK_PX } from './nuke-ai-bot';

describe('NukeAiBot', () => {
    it('renders a decorative theme-aware mascot without native titles', () => {
        const html = renderToStaticMarkup(<NukeAiBot />);

        expect(html).toContain('class="nuke-ai-bot"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('focusable="false"');
        expect(html).toContain('nuke-ai-bot-head');
        expect(html).toContain('nuke-ai-bot-blink');
        expect(html).toContain('nuke-ai-bot-eye');
        expect(html).toContain('nuke-ai-bot-eye-glow');
        expect(html).toContain('nuke-ai-bot-tilt');
        expect(html).toContain('nuke-ai-bot-shadow');
        expect(html).toContain('nuke-ai-bot-mouth');
        expect(html).not.toContain('nuke-ai-bot-visor');
        expect(html).not.toContain('nuke-ai-bot-cheek');
        expect(html).not.toContain('title=');
    });

    it('supports a host class and explicit size for the large welcome logo', () => {
        const html = renderToStaticMarkup(<NukeAiBot className="theia-WelcomeMessage-Logo" size={112} />);

        expect(html).toContain('class="nuke-ai-bot theia-WelcomeMessage-Logo"');
        expect(html).toContain('width:112px');
        expect(html).toContain('height:112px');
    });

    it('maps pointer positions to clamped pupil offsets', () => {
        expect(computeBotLookOffset(100, 100, 100, 100)).toEqual({ x: 0, y: 0 });
        expect(computeBotLookOffset(240, 100, 100, 100)).toEqual({ x: NUKE_AI_BOT_MAX_LOOK_PX, y: 0 });
        expect(computeBotLookOffset(100, 240, 100, 100)).toEqual({ x: 0, y: NUKE_AI_BOT_MAX_LOOK_PX });
        expect(computeBotLookOffset(-1000, -1000, 100, 100)).toEqual({ x: -3, y: -3 });
    });

    it('honors a custom displacement limit', () => {
        expect(computeBotLookOffset(9999, 0, 0, 0, 5)).toEqual({ x: 5, y: 0 });
    });
});
