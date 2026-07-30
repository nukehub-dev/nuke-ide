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

import { injectable, inject, named } from '@theia/core/shared/inversify';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import URI from '@theia/core/lib/common/uri';

/**
 * A viewer for a specific OpenMC output file kind (particle tracks, collision
 * tracks, weight windows, kinetics, ...). Modeled on Theia's `OpenHandler`:
 * `canHandle` returns a score where 0 means "cannot handle". Contributions
 * register via `bind(OutputViewerContribution).to(...)` in a frontend module;
 * the {@link OutputViewerRegistry} routes matching files to them before the
 * generic open handlers run.
 */
export const OutputViewerContribution = Symbol('OutputViewerContribution');
export interface OutputViewerContribution {
    readonly id: string;
    readonly label: string;
    /** Tie-breaker when two contributions score a URI equally. Higher wins. */
    readonly priority: number;
    /** Score this URI: > 0 if this viewer can open it (higher = better match), 0 otherwise. */
    canHandle(uri: URI): number;
    open(uri: URI): Promise<void>;
}

/**
 * Pick the best contribution for `uri`: highest `canHandle` score wins,
 * ties broken by `priority`. Pure (no DI) so it is unit-testable.
 */
export function selectOutputViewer(uri: URI, contributions: readonly OutputViewerContribution[]): OutputViewerContribution | undefined {
    let best: OutputViewerContribution | undefined;
    let bestScore = 0;
    for (const contribution of contributions) {
        const score = contribution.canHandle(uri);
        if (score <= 0) {
            continue;
        }
        if (best === undefined || score > bestScore || (score === bestScore && contribution.priority > best.priority)) {
            best = contribution;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Registry of {@link OutputViewerContribution}s. Consulted first by the
 * extension's open handlers (`VisualizerOpenHandler`, `OpenMCContribution`)
 * so specialized OpenMC output viewers are drop-in registrations instead of
 * open-handler edits.
 */
@injectable()
export class OutputViewerRegistry {
    constructor(
        @inject(ContributionProvider)
        @named(OutputViewerContribution)
        protected readonly contributions: ContributionProvider<OutputViewerContribution>
    ) {}

    /** The winning contribution for `uri`, or undefined when none matches. */
    getHandlerFor(uri: URI): OutputViewerContribution | undefined {
        return selectOutputViewer(uri, this.contributions.getContributions());
    }
}
