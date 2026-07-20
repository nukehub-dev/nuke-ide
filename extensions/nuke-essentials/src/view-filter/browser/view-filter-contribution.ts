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

import { ContributionFilterRegistry, FilterContribution } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { injectable, inject } from '@theia/core/shared/inversify';

import { DebugFrontendApplicationContribution } from '@theia/debug/lib/browser/debug-frontend-application-contribution';
import { TestViewContribution } from '@theia/test/lib/browser/view/test-view-contribution';
import { TestRunViewContribution } from '@theia/test/lib/browser/view/test-run-view-contribution';
import { TestResultViewContribution } from '@theia/test/lib/browser/view/test-result-view-contribution';
import { TestOutputViewContribution } from '@theia/test/lib/browser/view/test-output-view-contribution';

/**
 * NukeIDE is a nuclear simulation IDE, so the generic debugger and test-runner
 * UI is filtered out entirely: activity bar views, Run menu entries, commands,
 * and keybindings contributed by these classes never get registered.
 */
const FILTERED_CONTRIBUTIONS: Function[] = [
    // @theia/debug: Debug view, Run menu, debug commands/keybindings
    DebugFrontendApplicationContribution,
    // @theia/test: Testing view container and all test run/result/output views
    TestViewContribution,
    TestRunViewContribution,
    TestResultViewContribution,
    TestOutputViewContribution
];

/**
 * Widget ids that may still be restored from stale layout state saved before
 * the contributions above were filtered out (the widget factories remain
 * bound, so the shell happily recreates them). Closed once after layout init.
 */
const STALE_WIDGET_IDS = ['debug', 'test-view-container'];

@injectable()
export class ViewFilterContribution implements FilterContribution {
    registerContributionFilters(registry: ContributionFilterRegistry): void {
        registry.addFilters('*', [
            (contrib) => !FILTERED_CONTRIBUTIONS.some((filtered) => contrib instanceof (filtered as new () => object))
        ]);
    }
}

/**
 * Closes filtered-out widgets that are still restored from stale layout state
 * saved before the filter was introduced (the widget factories remain bound,
 * so the shell happily recreates them). Runs once after layout init.
 *
 * Kept separate from ViewFilterContribution: FilterContribution instances are
 * multi-injected while the contribution filter registry is being constructed,
 * so they must not inject anything (injecting ApplicationShell caused a
 * resolution cycle: shell -> contributions -> filter registry -> shell).
 */
@injectable()
export class StaleViewCleanupContribution implements FrontendApplicationContribution {
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    onDidInitializeLayout(): void {
        for (const id of STALE_WIDGET_IDS) {
            this.shell.getWidgetById(id)?.close();
        }
    }
}
