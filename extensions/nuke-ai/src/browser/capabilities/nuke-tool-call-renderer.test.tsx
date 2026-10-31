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

import { describe, expect, it, vi } from 'vitest';
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResponseNode } from '@theia/ai-chat-ui/lib/browser/chat-tree-view/chat-view-tree-widget';
import type { ToolCallChatResponseContent } from '@theia/ai-chat/lib/common';
import { NukeToolCallRenderer } from './nuke-tool-call-renderer';
import type { NukeNextActionService } from './nuke-next-action-service';

vi.mock('@theia/core/lib/browser', () => ({
    OpenerService: Symbol('OpenerService'),
    open: vi.fn()
}));

function createRenderer(canRunDirectly = true): NukeToolCallRenderer {
    const renderer = new NukeToolCallRenderer();
    const nextActionService = {
        canRunDirectly: vi.fn(() => canRunDirectly),
        run: vi.fn(),
        ask: vi.fn()
    };
    (renderer as unknown as { openerService: unknown }).openerService = { getOpener: vi.fn() };
    (renderer as unknown as { nextActionService: NukeNextActionService }).nextActionService =
        nextActionService as unknown as NukeNextActionService;
    return renderer;
}

function response(overrides: Partial<ToolCallChatResponseContent> = {}): ToolCallChatResponseContent {
    return {
        kind: 'toolCall',
        name: 'nuke_cad_summarizeDocument',
        arguments: '{"includeSolids":true}',
        finished: true,
        isAwaitingUserConfirmation: false,
        result: {
            content: [
                { type: 'text', text: 'CAD document summarized.' },
                {
                    type: 'text',
                    text: JSON.stringify({
                        ok: true,
                        data: {
                            documentPath: '/workspace/model.nuke-cad',
                            solidCount: 2,
                            faceCount: 12,
                            triangleCount: 24,
                            selection: { solidId: 1 }
                        },
                        nextActions: [{ capability: 'nuke.openmc.validateProject', reason: 'Validate the project next.' }]
                    })
                }
            ]
        },
        updateResult: vi.fn(),
        ...overrides
    } as unknown as ToolCallChatResponseContent;
}

describe('NukeToolCallRenderer', () => {
    it('claims a finished Nuke call and renders the glue into the card markup', () => {
        const renderer = createRenderer(true);
        const content = response();

        expect(renderer.canHandle(content)).toBe(30);
        const html = renderToStaticMarkup(renderer.render(content, {} as ResponseNode) as React.ReactElement);

        expect(html).toContain('nuke-tool-card');
        expect(html).toContain('CAD summary');
        expect(html).toContain('Done');
        expect(html).toContain('CAD document summarized.');
        expect(html).toContain('Solids');
        expect(html).toContain('Validate the project next.');
        expect(html).toContain('>Run<');
        expect(html).toContain('includeSolids');
    });

    it('does not claim running, awaiting, or non-Nuke tool calls', () => {
        const renderer = createRenderer();

        expect(renderer.canHandle(response({ finished: false }))).toBe(-1);
        expect(renderer.canHandle(response({ isAwaitingUserConfirmation: true }))).toBe(-1);
        expect(renderer.canHandle(response({ name: 'other_tool' }))).toBe(-1);
        expect(renderer.canHandle({ kind: 'markdownContent' } as never)).toBe(-1);
    });

    it('renders Ask NukeAI for a state-changing next action', () => {
        const renderer = createRenderer(false);
        const html = renderToStaticMarkup(renderer.render(response(), {} as ResponseNode) as React.ReactElement);

        expect(html).toContain('Ask NukeAI');
        expect(html).not.toContain('>Run<');
    });
});
