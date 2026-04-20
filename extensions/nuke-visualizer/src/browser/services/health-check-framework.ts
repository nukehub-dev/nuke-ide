// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0
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
