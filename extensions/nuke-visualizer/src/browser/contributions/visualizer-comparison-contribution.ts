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
 * Comparison workspace commands: group 2–4 already-open native 3D views into
 * linked split panes and unlink them again.
 *
 * No data is loaded here; the command only rearranges existing viewers.
 *
 * @module nuke-visualizer/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MessageService } from '@theia/core/lib/common';
import { ApplicationShell, QuickInputService, QuickPickItem, Widget } from '@theia/core/lib/browser';
import { CompareOpenViewsCommand, StopComparisonCommand } from '../commands/visualizer-commands';
import { createComparisonSession, isComparisonViewHost, type ComparisonViewHost } from '../viewer-core/comparison-session';
import { OpenViewerSettingsCommand } from '../viewer-settings/viewer-settings-contribution';
import { ViewerSettingsWidget } from '../viewer-settings/viewer-settings-widget';

/** One quick-pick row per open native viewer, addressed by widget id. */
interface ComparisonViewerPick extends QuickPickItem {
    id: string;
}

const MIN_COMPARISON_VIEWS = 2;
const MAX_COMPARISON_VIEWS = 4;

@injectable()
export class VisualizerComparisonContribution implements CommandContribution {
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(CompareOpenViewsCommand, {
            execute: () => this.compareOpenViews()
        });
        commands.registerCommand(StopComparisonCommand, {
            execute: () => this.stopComparison()
        });
    }

    /**
     * Comparison-capable viewers currently docked in the main area (open tabs
     * and split panes): the generic native viewer, tally-native viewers, and
     * the DAGMC viewer all expose the comparison-host surface.
     */
    protected getNativeViewers(): (Widget & ComparisonViewHost)[] {
        return this.shell
            .getWidgets('main')
            .filter((widget): widget is Widget & ComparisonViewHost => isComparisonViewHost(widget) && !widget.isDisposed);
    }

    async compareOpenViews(): Promise<void> {
        try {
            const viewers = this.getNativeViewers();
            if (viewers.length < MIN_COMPARISON_VIEWS) {
                await this.messageService.info('Open at least two 3D views, then run Compare Open Views...');
                return;
            }

            const items: ComparisonViewerPick[] = viewers.map((viewer) => ({
                id: viewer.id,
                label: viewer.title.label,
                description: viewer.title.caption
            }));
            const picked = await this.quickInput.pick(items, {
                canPickMany: true,
                title: 'Compare Open Views',
                placeHolder: 'Select 2–4 open 3D views'
            });
            if (!picked || picked.length < MIN_COMPARISON_VIEWS) {
                return;
            }
            if (picked.length > MAX_COMPARISON_VIEWS) {
                await this.messageService.warn('Compare supports at most four views.');
                return;
            }

            // The pick order becomes the A/B/C... pane order.
            const viewerById = new Map(viewers.map((viewer) => [viewer.id, viewer] as const));
            const selected = picked
                .map((item) => viewerById.get(item.id))
                .filter((viewer): viewer is Widget & ComparisonViewHost => viewer !== undefined);
            if (selected.length < MIN_COMPARISON_VIEWS) {
                return;
            }

            const sessionId = `comparison-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const session = createComparisonSession(
                sessionId,
                selected.map((viewer) => ({ viewId: viewer.id, title: viewer.title.label }))
            );

            for (const pane of session.panes) {
                const viewer = viewerById.get(pane.viewId);
                if (!viewer) {
                    continue;
                }
                viewer.joinComparison({
                    sessionId,
                    label: pane.label,
                    linkCameras: true,
                    sharedRange: true,
                    showLabels: true
                });
            }

            // First pane keeps its position; each following pane splits right of
            // the previous one, so the panes end up side by side left to right.
            const [first, ...rest] = selected;
            await this.shell.activateWidget(first.id);
            let ref: Widget = first;
            for (const viewer of rest) {
                await this.shell.addWidget(viewer, { area: 'main', mode: 'split-right', ref });
                ref = viewer;
            }
            // Splitting activates the last pane; re-activate the first so the
            // Viewer Settings panel rebinds (and re-reads the comparison
            // section) if it was already open before the command ran.
            await this.shell.activateWidget(first.id);

            first.syncComparisonCamera();
            await this.commands.executeCommand(OpenViewerSettingsCommand.id);
            this.refreshSettingsPanel();

            const labels = session.panes.map((pane) => pane.label).join(', ');
            await this.messageService.info(`Comparing ${session.panes.length} views — cameras and color ranges linked. Panes: ${labels}.`);
        } catch (error) {
            await this.messageService.error(`Compare Open Views failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Re-read the open Viewer Settings panel after a comparison-state edit. */
    protected refreshSettingsPanel(): void {
        const existing = this.shell.getWidgets('right').find((widget) => widget instanceof ViewerSettingsWidget);
        if (existing instanceof ViewerSettingsWidget) {
            existing.refresh();
        }
    }

    async stopComparison(): Promise<void> {
        try {
            let unlinked = 0;
            for (const viewer of this.getNativeViewers()) {
                if (viewer.getComparisonView() !== undefined) {
                    viewer.leaveComparison();
                    unlinked++;
                }
            }
            if (unlinked === 0) {
                await this.messageService.info('No active comparison session.');
                return;
            }
            this.refreshSettingsPanel();
            await this.messageService.info(`Unlinked ${unlinked} comparison view${unlinked === 1 ? '' : 's'}.`);
        } catch (error) {
            await this.messageService.error(`Stop Comparison failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
