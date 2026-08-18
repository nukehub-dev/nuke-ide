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
 * Dependency Install Planner
 *
 * Pure routing of {@link PackageDependency} entries to install commands.
 * Given the dependency definitions and whether the target environment is
 * conda-managed, produces a plan that {@link PackageService} turns into shell
 * commands:
 *
 * - Conda environments: entries with `condaOnly` or `condaSpec` are batched
 *   into a single conda install (union of channels, default `conda-forge`);
 *   every other entry installs via pip.
 * - Non-conda environments: everything installs via pip; `condaOnly` entries
 *   cannot be auto-installed and are reported as `skipped` (hint-only).
 *
 * Pip entries are grouped by identical (`extraIndexUrl`, `pipArgs`) signature
 * so e.g. a `--no-deps` install never shares a command with a normal one.
 *
 * Kept free of Theia/inversify imports so vitest can exercise it directly.
 *
 * @module nuke-core/node
 * @see {@link PackageService.prepareDependencyInstallCommands}
 */

import { PackageDependency } from '../../common/nuke-core-protocol';

/** Result of planning the installation of a set of package dependencies. */
export interface DependencyInstallPlan {
    /** Batched conda install (present when at least one entry routes to conda) */
    conda?: {
        /** Conda package specs (`condaSpec || name`) */
        specs: string[];
        /** Union of the entries' channels, defaulting to ['conda-forge'] */
        channels: string[];
    };
    /** Pip install groups, one per distinct (`extraIndexUrl`, `pipArgs`) signature */
    pip: Array<{
        /** Pip requirement specs (`pipSpec || name`) */
        specs: string[];
        /** Extra pip arguments shared by the group */
        args: string[];
        /** Extra pip index URL shared by the group */
        extraIndexUrl?: string;
    }>;
    /** Entries that cannot be auto-installed in this environment (condaOnly in a non-conda env) */
    skipped: PackageDependency[];
}

/**
 * Route package dependencies to conda/pip install groups for the target environment.
 *
 * @param defs - The dependency entries to install (typically the missing ones).
 * @param isCondaEnv - Whether the target Python lives in a conda environment.
 * @returns The install plan; both `conda` and `pip` may be empty when nothing is installable.
 */
export function buildDependencyInstallPlan(defs: PackageDependency[], isCondaEnv: boolean): DependencyInstallPlan {
    const condaSpecs: string[] = [];
    const condaChannels: string[] = [];
    const pipGroups = new Map<string, { specs: string[]; args: string[]; extraIndexUrl?: string }>();
    const skipped: PackageDependency[] = [];

    for (const def of defs) {
        if (isCondaEnv && (def.condaOnly || def.condaSpec)) {
            condaSpecs.push(def.condaSpec ?? def.name);
            for (const channel of def.channels ?? []) {
                if (!condaChannels.includes(channel)) {
                    condaChannels.push(channel);
                }
            }
            continue;
        }
        if (def.condaOnly) {
            // Conda-only package in a non-conda environment — hint-only
            skipped.push(def);
            continue;
        }
        const args = def.pipArgs ?? [];
        const key = JSON.stringify([def.extraIndexUrl ?? '', ...args]);
        let group = pipGroups.get(key);
        if (!group) {
            group = { specs: [], args, extraIndexUrl: def.extraIndexUrl };
            pipGroups.set(key, group);
        }
        group.specs.push(def.pipSpec ?? def.name);
    }

    const plan: DependencyInstallPlan = { pip: [...pipGroups.values()], skipped };
    if (condaSpecs.length > 0) {
        plan.conda = { specs: condaSpecs, channels: condaChannels.length > 0 ? condaChannels : ['conda-forge'] };
    }
    return plan;
}
