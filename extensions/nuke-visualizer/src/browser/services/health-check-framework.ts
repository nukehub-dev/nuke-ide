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

/**
 * Plugin-agnostic health check framework for nuke-visualizer.
 *
 * Each visualization plugin registers its {@link PackageDependency} requirements
 * during initialization. The framework then provides unified health checks
 * across all registered plugins by delegating to `NukeCoreService`.
 *
 * ### Usage
 * ```typescript
 * this.healthFramework.registerHealthRequirements({
 *     id: 'my-plugin',
 *     name: 'My Plugin',
 *     packages: [{ name: 'my-package', required: true }]
 * });
 * const report = await this.healthFramework.runAllHealthChecks();
 * ```
 *
 * @see src/browser/visualizer-contribution.ts for health check UI integration
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { NukeCoreService } from 'nuke-core/lib/common';
import { PackageDependency } from 'nuke-core/lib/common';

export interface PluginHealthRequirements {
    /** Unique plugin identifier (e.g., 'openmc', 'moose') */
    id: string;
    /** Human-readable plugin name */
    name: string;
    /** Packages required by this plugin */
    packages: PackageDependency[];
}

export interface PluginHealthReport {
    pluginId: string;
    pluginName: string;
    healthy: boolean;
    checks: HealthCheckItem[];
}

export interface HealthCheckItem {
    name: string;
    passed: boolean;
    message: string;
    severity?: 'error' | 'warning';
    suggestion?: string;
}

export interface UnifiedHealthReport {
    /** Overall health across all plugins */
    healthy: boolean;
    /** Per-plugin reports */
    plugins: PluginHealthReport[];
}

@injectable()
export class HealthCheckFramework {

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    private readonly requirements = new Map<string, PluginHealthRequirements>();

    /**
     * Register a plugin's health requirements.
     * Called by each plugin during initialization.
     */
    registerHealthRequirements(req: PluginHealthRequirements): void {
        this.requirements.set(req.id, req);
    }

    /**
     * Get registered requirements for a plugin.
     */
    getRequirements(pluginId: string): PluginHealthRequirements | undefined {
        return this.requirements.get(pluginId);
    }

    /**
     * Get all registered plugin requirements.
     */
    getAllRequirements(): PluginHealthRequirements[] {
        return Array.from(this.requirements.values());
    }

    /**
     * Run health check for a specific plugin.
     * A plugin is healthy only if all its required packages are available.
     * Infrastructure checks (Python env, conda, uv) are included but don't
     * block plugin health — missing required packages do.
     */
    async runHealthCheck(pluginId: string): Promise<PluginHealthReport | undefined> {
        const req = this.requirements.get(pluginId);
        if (!req) {
            return undefined;
        }

        // Pass full PackageDependency[] to nuke-core so it can build proper suggestions
        const result = await this.nukeCore.healthCheck(req.packages);

        // Check if all required packages passed
        const requiredPackageNames = req.packages
            .filter(p => p.required !== false)
            .map(p => p.name);
        const packageChecks = result.checks.filter(c =>
            requiredPackageNames.some(pkg => c.name === `Package: ${pkg}`)
        );
        const allPackagesPassed = packageChecks.every(c => c.passed);

        return {
            pluginId: req.id,
            pluginName: req.name,
            healthy: allPackagesPassed,
            checks: result.checks
        };
    }

    /**
     * Run health checks for ALL registered plugins.
     */
    async runAllHealthChecks(): Promise<UnifiedHealthReport> {
        const reports: PluginHealthReport[] = [];

        for (const req of this.requirements.values()) {
            const report = await this.runHealthCheck(req.id);
            if (report) {
                reports.push(report);
            }
        }

        return {
            healthy: reports.every(r => r.healthy),
            plugins: reports
        };
    }
}
