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
import { Command, CommandHandler, CommandRegistry } from '@theia/core/lib/common/command';
import { Disposable } from '@theia/core/lib/common/disposable';
import { NukePreviewGalleryCommands, NukePreviewGalleryContribution } from './nuke-preview-gallery-commands';
import { NukePreviewGalleryEntry } from './nuke-preview-gallery-service';
import { NukePreviewGalleryView } from './nuke-preview-gallery-widget';

vi.mock('@theia/core/lib/browser', () => ({
    AbstractViewContribution: class AbstractViewContribution<T> {
        constructor(protected readonly options: unknown) {}
        registerCommands(): void {}
        async openView(args?: unknown): Promise<T | undefined> {
            return args as T | undefined;
        }
    },
    OpenerService: Symbol('OpenerService'),
    open: vi.fn()
}));
vi.mock('@theia/core/lib/browser/widgets/react-widget', () => ({
    ReactWidget: class ReactWidget {
        addClass(): void {}
        update(): void {}
    }
}));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: Symbol('FileService') }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: Symbol('WorkspaceService') }));
vi.mock('./nuke-preview-gallery.css', () => ({}));

function entry(overrides: Partial<NukePreviewGalleryEntry> = {}): NukePreviewGalleryEntry {
    return {
        sessionId: '20260102-030405-abcdef',
        bundleId: 'bundle-001',
        createdAt: '2026-01-02T03:04:05.000Z',
        previewPath: '/workspace/.nuke-ide/ai/previews/20260102-030405-abcdef/bundle-001/preview.png',
        caption: 'Active DAGMC viewport',
        capabilityId: 'nuke.viz.captureView',
        resultPath: '/workspace/.nuke-ide/ai/previews/20260102-030405-abcdef/bundle-001/result.json',
        ...overrides
    };
}

function renderView(overrides: Partial<React.ComponentProps<typeof NukePreviewGalleryView>> = {}): string {
    return renderToStaticMarkup(
        <NukePreviewGalleryView entries={[entry()]} loading={false} onOpen={() => undefined} onRefresh={() => undefined} {...overrides} />
    );
}

class FakeCommandRegistry {
    readonly handlers = new Map<string, CommandHandler>();

    registerCommand(command: Command, handler?: CommandHandler): Disposable {
        if (handler) {
            this.handlers.set(command.id, handler);
        }
        return Disposable.NULL;
    }

    execute(commandId: string): Promise<unknown> {
        const handler = this.handlers.get(commandId);
        if (!handler) {
            throw new Error(`Command ${commandId} is not registered.`);
        }
        return Promise.resolve(handler.execute());
    }
}

describe('NukePreviewGalleryView', () => {
    it('renders a card with the caption, capability, file, and timestamp', () => {
        const html = renderView();

        expect(html).toContain('Preview Gallery');
        expect(html).toContain('Read-only history of previews');
        expect(html).toContain('Active DAGMC viewport');
        expect(html).toContain('nuke.viz.captureView');
        expect(html).toContain('preview.png');
        expect(html).toContain('2026-01-02 03:04');
        expect(html).toContain('data-session-id="20260102-030405-abcdef"');
        expect(html).toContain('data-bundle-id="bundle-001"');
    });

    it('falls back to the bundle id and result file when metadata is absent', () => {
        const html = renderView({
            entries: [entry({ caption: undefined, capabilityId: undefined, previewPath: undefined })]
        });

        expect(html).toContain('bundle-001');
        expect(html).toContain('NukeAI preview');
        expect(html).toContain('result.json');
    });

    it('renders the empty state that explains how previews appear', () => {
        const html = renderView({ entries: [] });

        expect(html).toContain('data-state="empty"');
        expect(html).toContain('No previews yet');
        expect(html).toContain('captures a viewport or returns a result with a preview or artifact');
        expect(html).not.toContain('nuke-preview-gallery-grid');
    });

    it('renders the loading and error states', () => {
        const loading = renderView({ entries: [], loading: true });
        expect(loading).toContain('Scanning saved previews');

        const error = renderView({ entries: [], error: 'Could not scan.' });
        expect(error).toContain('role="alert"');
        expect(error).toContain('Could not scan.');
    });

    it('does not use native title attributes for hints', () => {
        expect(renderView()).not.toContain('title=');
    });
});

describe('NukePreviewGalleryContribution', () => {
    it('registers the open-gallery command and opens the view', async () => {
        const registry = new FakeCommandRegistry();
        const contribution = new NukePreviewGalleryContribution();
        const openView = vi.spyOn(contribution, 'openView').mockResolvedValue(undefined as never);

        contribution.registerCommands(registry as unknown as CommandRegistry);
        expect([...registry.handlers.keys()]).toEqual([NukePreviewGalleryCommands.OPEN.id]);

        await registry.execute(NukePreviewGalleryCommands.OPEN.id);

        expect(openView).toHaveBeenCalledWith({ activate: true });
        expect(NukePreviewGalleryCommands.OPEN.label).toBe('NukeAI: Open Preview Gallery');
    });
});
