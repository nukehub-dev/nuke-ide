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
 * Nuke Context Action Protocol
 *
 * Neutral cross-extension contract for contextual menu actions. Domain widgets
 * render actions from known scopes; contributors register command-backed
 * descriptors without the domain importing the contributing extension. The
 * contract has no AI, CAD, or OpenMC dependency.
 *
 * @module nuke-core/common
 */

import type { Event } from '@theia/core/lib/common/event';

/** Domains that own a contextual surface and the actions it can render. */
export type NukeContextActionScope = 'cad.viewport' | 'openmc.validation' | 'openmc.run' | 'visualizer.dagmc' | 'visualizer.tally';

/** Every scope accepted by the registry, in menu-surface order. */
export const NUKE_CONTEXT_ACTION_SCOPES: readonly NukeContextActionScope[] = [
    'cad.viewport',
    'openmc.validation',
    'openmc.run',
    'visualizer.dagmc',
    'visualizer.tally'
];

/** One command-backed action contributed to a domain menu surface. */
export interface NukeContextAction {
    /** Stable, globally unique action id; duplicate ids keep the first registration. */
    readonly id: string;
    /** Domain surface that renders the action. */
    readonly scope: NukeContextActionScope;
    /** User-facing row label. */
    readonly label: string;
    /** Optional longer explanation for tooltips and documentation. */
    readonly description?: string;
    /** Theia command executed when the row is chosen. */
    readonly commandId: string;
    /** Primary sort key; omitted actions sort before grouped ones. */
    readonly group?: string;
    /** Secondary sort key within the group; omitted actions sort first. */
    readonly order?: string;
    /** Synchronous availability predicate; a false result or a throw hides the action. */
    readonly when?: () => boolean;
}

/** DI symbol for the {@link NukeContextActionContribution} provider. */
export const NukeContextActionContribution = Symbol('NukeContextActionContribution');
export interface NukeContextActionContribution {
    registerContextActions(registry: NukeContextActionRegistry): void;
}

/** DI symbol for the neutral context-action registry. */
export const NukeContextActionRegistry = Symbol('NukeContextActionRegistry');
export interface NukeContextActionRegistry {
    /** Register one action; invalid or duplicate actions are logged and skipped. */
    register(action: NukeContextAction): void;
    /** Enabled actions for one scope in stable group/order/label order. */
    getActions(scope: NukeContextActionScope): readonly NukeContextAction[];
    /** Fires after the initial contribution pass and after every later accepted registration. */
    readonly onDidChange: Event<void>;
}
