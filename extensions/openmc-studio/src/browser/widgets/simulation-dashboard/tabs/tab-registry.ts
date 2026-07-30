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

import * as React from '@theia/core/shared/react';
import { injectable, inject, named } from '@theia/core/shared/inversify';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';

import { OpenMCState } from '../../../../common/openmc-state-schema';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';

/**
 * Contribution point for Simulation Dashboard tabs.
 *
 * Bind implementations against this symbol in the frontend module to add a
 * tab to the dashboard; the {@link DashboardTabRegistry} collects them.
 */
export const DashboardTabContribution = Symbol('DashboardTabContribution');
export interface DashboardTabContribution {
    /** Unique tab identifier, also used by `SimulationDashboardWidget.setActiveTab`. */
    readonly id: string;
    /** Display label of the tab button. */
    readonly label: string;
    /** Codicon name without the `codicon-` prefix, e.g. 'settings-gear'. */
    readonly icon: string;
    /** Sort order among the dashboard tabs. */
    readonly order: number;
    /**
     * Optional visibility predicate; tabs without it are always visible.
     * @param state - Current OpenMC simulation state.
     * @returns Whether the tab should be shown.
     */
    isVisible?(state: OpenMCState): boolean;
    /**
     * Render the tab content.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Tab content React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode;
}

/**
 * Registry that collects all {@link DashboardTabContribution}s and exposes
 * them sorted by `order` and filtered by `isVisible`.
 */
@injectable()
export class DashboardTabRegistry {
    constructor(
        @inject(ContributionProvider)
        @named(DashboardTabContribution)
        protected readonly contributions: ContributionProvider<DashboardTabContribution>
    ) {}

    /**
     * Get the registered tabs applicable to the given state.
     * @param state - Current OpenMC simulation state.
     * @returns Visible tabs sorted by their `order`.
     */
    getTabs(state: OpenMCState): DashboardTabContribution[] {
        return this.contributions
            .getContributions()
            .filter((tab) => !tab.isVisible || tab.isVisible(state))
            .sort((a, b) => a.order - b.order);
    }
}
