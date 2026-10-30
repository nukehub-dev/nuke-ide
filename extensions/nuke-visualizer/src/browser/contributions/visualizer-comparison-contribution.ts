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
 * Comparison workspace commands: group 2–4 native 3D views into linked split
 * panes and unlink them again.
 *
 * `Compare Open Views...` picks from viewers that are already open;
 * `Compare Files...` browses for files, opens them through the visualizer
 * open handler, and compares the resulting viewers. Both flows share
 * {@link VisualizerComparisonContribution.startComparison}.
 *
 * No data is loaded by the open-views flow; that command only rearranges
 * existing viewers.
 *
 * @module nuke-visualizer/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MessageService } from '@theia/core/lib/common';
import { ApplicationShell, QuickInputService, QuickPickItem, Widget } from '@theia/core/lib/browser';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { CompareFilesCommand, CompareOpenViewsCommand, StopComparisonCommand } from '../commands/visualizer-commands';
import { createComparisonSession, isComparisonViewHost, type ComparisonViewHost } from '../viewer-core/comparison-session';
import { comparisonPanePlacements } from '../viewer-core/comparison-layout';
import { VisualizerOpenHandler } from './visualizer-open-handler';
import { OpenViewerSettingsCommand } from '../viewer-settings/viewer-settings-contribution';
import { ViewerSettingsWidget } from '../viewer-settings/viewer-settings-widget';

/** One quick-pick row per open native viewer, addressed by widget id. */
interface ComparisonViewerPick extends QuickPickItem {
    id: string;
}

/** A viewer that is both docked in the shell and comparison-capable. */
type ComparisonPaneWidget = Widget & ComparisonViewHost;

const MIN_COMPARISON_VIEWS = 2;
const MAX_COMPARISON_VIEWS = 4;

/** File types the comparison file browser offers (`msh` is Gmsh). */
const COMPARE_FILE_FILTERS = {
    'VTK Files': ['vtk', 'vtu', 'vtp', 'vts', 'vtr', 'pvtu', 'pvtp'],
    'DAGMC Files': ['h5m'],
    'CAD Files': ['step', 'stp', 'brep'],
    'Mesh Files': ['stl', 'ply', 'obj'],
    'Gmsh Files': ['msh']
};

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

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(VisualizerOpenHandler)
    protected readonly openHandler: VisualizerOpenHandler;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(CompareOpenViewsCommand, {
            execute: () => this.compareOpenViews()
        });
        commands.registerCommand(CompareFilesCommand, {
            execute: () => this.compareFiles()
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
    protected getNativeViewers(): ComparisonPaneWidget[] {
        return this.shell
            .getWidgets('main')
            .filter((widget): widget is ComparisonPaneWidget => isComparisonViewHost(widget) && !widget.isDisposed);
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
                .filter((viewer): viewer is ComparisonPaneWidget => viewer !== undefined);
            if (selected.length < MIN_COMPARISON_VIEWS) {
                return;
            }

            await this.startComparison(selected);
        } catch (error) {
            await this.messageService.error(`Compare Open Views failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Browse for 2–4 files, open them one at a time through the visualizer
     * open handler, and compare the resulting viewers. All files are opened
     * before any pane is linked, so a failed open cannot leave a half-linked
     * comparison behind.
     */
    async compareFiles(): Promise<void> {
        try {
            const selection = await this.fileDialogService.showOpenDialog({
                title: 'Compare Files',
                openLabel: 'Compare',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: true,
                filters: COMPARE_FILE_FILTERS
            });
            if (!selection || (Array.isArray(selection) && selection.length === 0)) {
                return;
            }

            const uris = Array.isArray(selection) ? selection : [selection];
            if (uris.length < MIN_COMPARISON_VIEWS) {
                await this.messageService.info('Select at least two files to compare.');
                return;
            }
            if (uris.length > MAX_COMPARISON_VIEWS) {
                await this.messageService.warn('Compare supports at most four files.');
                return;
            }

            const opened: ComparisonPaneWidget[] = [];
            const seen = new Set<string>();
            for (const uri of uris) {
                const widget = await this.openHandler.open(uri);
                if (!widget || widget.isDisposed || !isComparisonViewHost(widget) || seen.has(widget.id)) {
                    continue;
                }
                seen.add(widget.id);
                opened.push(widget);
            }
            if (opened.length < MIN_COMPARISON_VIEWS) {
                await this.messageService.info(
                    'Compare needs at least two comparable 3D viewers. Pick files the visualizer can render as 3D data.'
                );
                return;
            }

            await this.startComparison(opened);
        } catch (error) {
            await this.messageService.error(`Compare Files failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Shared comparison flow: create the session, join every selected pane,
     * arrange the panes, and refresh Viewer Settings. Joined panes are
     * unlinked again if any later step fails.
     */
    protected async startComparison(selected: readonly ComparisonPaneWidget[]): Promise<void> {
        if (selected.length < MIN_COMPARISON_VIEWS || selected.length > MAX_COMPARISON_VIEWS) {
            throw new Error(`A comparison needs between ${MIN_COMPARISON_VIEWS} and ${MAX_COMPARISON_VIEWS} views.`);
        }

        const sessionId = `comparison-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const session = createComparisonSession(
            sessionId,
            selected.map((viewer) => ({ viewId: viewer.id, title: viewer.title.label }))
        );
        if (session.panes.length < MIN_COMPARISON_VIEWS) {
            throw new Error('A comparison needs at least two distinct views.');
        }

        const viewerById = new Map(selected.map((viewer) => [viewer.id, viewer] as const));
        const panes = session.panes
            .map((pane) => viewerById.get(pane.viewId))
            .filter((viewer): viewer is ComparisonPaneWidget => viewer !== undefined);

        const joined: ComparisonPaneWidget[] = [];
        try {
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
                joined.push(viewer);
            }

            await this.arrangeComparisonPanes(panes);
            panes[0].syncComparisonCamera();
            await this.commands.executeCommand(OpenViewerSettingsCommand.id);
            this.refreshSettingsPanel();

            const labels = session.panes.map((pane) => pane.label).join(', ');
            await this.messageService.info(`Comparing ${session.panes.length} views — cameras and color ranges linked. Panes: ${labels}.`);
        } catch (error) {
            for (const viewer of joined) {
                if (!viewer.isDisposed) {
                    viewer.leaveComparison();
                }
            }
            this.refreshSettingsPanel();
            throw error;
        }
    }

    /**
     * Dock the panes in comparison order. The first pane keeps its position;
     * {@link comparisonPanePlacements} decides every split. Bottom splits run
     * first: docking the bottom row before the top-right pane keeps four panes
     * in a true 2x2 grid instead of leaving the right pane spanning both rows.
     */
    protected async arrangeComparisonPanes(panes: readonly ComparisonPaneWidget[]): Promise<void> {
        const first = panes[0];
        if (!first) {
            return;
        }
        const placements = comparisonPanePlacements(panes.length);
        const ordered = [
            ...placements.filter((placement) => placement.mode === 'split-bottom'),
            ...placements.filter((placement) => placement.mode === 'split-right')
        ];
        await this.shell.activateWidget(first.id);
        for (const placement of ordered) {
            await this.shell.addWidget(panes[placement.pane], {
                area: 'main',
                mode: placement.mode,
                ref: panes[placement.ref]
            });
        }
        // Splitting activates the last pane; re-activate the first so the
        // Viewer Settings panel rebinds (and re-reads the comparison section)
        // if it was already open before the command ran.
        await this.shell.activateWidget(first.id);
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
