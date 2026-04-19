// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Nuke Core Extension Protocol
 * 
 * Core infrastructure protocol for NukeIDE - Python environment, configuration,
 * and shared utilities across extensions.
 * 
 * @module nuke-core/common
 */

import type { Event } from '@theia/core/lib/common/event';

export const NUKE_CORE_BACKEND_PATH = '/services/nuke-core';

/** Symbol for the backend service */
export const NukeCoreBackendService = Symbol('NukeCoreBackendService');

/** Python configuration */
export interface PythonConfig {
    /** Path to Python executable */
    pythonPath?: string;
    /** Conda environment name */
    condaEnv?: string;
    /** Comma-separated conda channels (default: conda-forge) */
    condaChannels?: string;
    /** Extra pip index URL for private packages */
    pipExtraIndexUrl?: string;
}

/** Information about a Nuke environment */
export interface NukeEnvironment {
    /** Display name */
    name: string;
    /** Python executable path */
    pythonPath: string;
    /** Type of environment */
    type: 'system' | 'conda' | 'venv' | 'virtualenv' | 'pyenv' | 'poetry';
    /** Python version (e.g., "3.10.4") */
    version?: string;
    /** Whether this environment is active/selected */
    isActive?: boolean;
    /** Path to environment directory (for venv/conda) */
    envPath?: string;
    /** Whether this environment can be deleted by the user */
    isDeletable?: boolean;
}

/** Result of Python detection */
export interface PythonDetectionResult {
    /** Whether detection was successful */
    success: boolean;
    /** Detected Python command */
    command?: string;
    /** Warning message if using fallback */
    warning?: string;
    /** Error message if detection failed */
    error?: string;
    /** Detected environment info */
    environment?: NukeEnvironment;
}

/** Result of listing environments */
export interface ListEnvironmentsResult {
    /** Available environments */
    environments: NukeEnvironment[];
    /** Currently selected environment */
    selected?: NukeEnvironment;
}

/** Package dependency to check */
export interface PackageDependency {
    /** Package name to import (e.g., 'trame', 'openmc') */
    name: string;
    /** Optional submodule path for version check (e.g., 'app' for trame.app) */
    submodule?: string;
    /** Whether this package is required or optional */
    required?: boolean;
    /** Minimum version required */
    minVersion?: string;
    /** Whether this package is only available via conda (not pip), e.g. paraview */
    condaOnly?: boolean;
    /** Conda channels to use for this package (defaults to global/preference channels) */
    channels?: string[];
    /** Extra pip index URL for this package (e.g. https://shimwell.github.io/wheels) */
    extraIndexUrl?: string;
}

/** Result of dependency check */
export interface DependencyCheckResult {
    /** Whether all required packages are available */
    available: boolean;
    /** List of missing required packages */
    missing: string[];
    /** Packages with version mismatches */
    versionMismatches: Array<{
        name: string;
        found: string;
        required: string;
    }>;
    /** Package versions that were found */
    versions: Record<string, string>;
}

/** Extended Python detection with required packages */
export interface PythonDetectionOptions {
    /** Required packages that must be present */
    requiredPackages?: PackageDependency[];
    /** Conda environment names to try for auto-detection (in order) */
    autoDetectEnvs?: string[];
    /** Whether to search for venvs in workspace */
    searchWorkspaceVenvs?: boolean;
}

/** Options for creating a new environment */
export interface CreateEnvironmentOptions {
    /** Type of environment to create */
    type: 'conda' | 'venv';
    /** Name of the environment */
    name: string;
    /** Python version (for conda) or path (for venv) */
    pythonSpecifier?: string;
    /** Working directory for creating the environment (defaults to workspace root) */
    cwd?: string;
    /** Conda channels to use during creation (conda only) */
    channels?: string[];
    /** Additional packages to install during creation (conda only, e.g. ['moose']) */
    packages?: string[];
}

/** Result of environment creation */
export interface CreateEnvironmentResult {
    /** Whether creation was successful */
    success: boolean;
    /** Created environment info */
    environment?: NukeEnvironment;
    /** Output from the creation command */
    output?: string;
    /** Error message if failed */
    error?: string;
}

/** Prepared command for creating an environment in a terminal */
export interface CreateEnvironmentCommand {
    /** Working directory for the command */
    cwd: string;
    /** Full shell command string to execute */
    command: string;
    /** Expected Python path after creation */
    expectedPythonPath: string;
}

/** Options for installing packages */
export interface PackageInstallOptions {
    /** Packages to install */
    packages: string[];
    /** Python path to use (defaults to detected) */
    pythonPath?: string;
    /** Whether to use conda (if available) or pip */
    useConda?: boolean;
    /** Additional arguments to pass to pip/conda */
    extraArgs?: string[];
    /** Working directory for running the install command */
    cwd?: string;
    /** Conda channels to use (overrides preference default) */
    channels?: string[];
    /** Extra pip index URL (overrides preference default) */
    extraIndexUrl?: string;
}

/** Result of package installation */
export interface PackageInstallResult {
    /** Whether installation was successful */
    success: boolean;
    /** Installed packages */
    installed: string[];
    /** Failed packages */
    failed: string[];
    /** Output from the install command */
    output?: string;
    /** Error message if failed */
    error?: string;
}

/** Health check result */
export interface HealthCheckResult {
    /** Overall health status */
    healthy: boolean;
    /** Individual check results */
    checks: HealthCheckItem[];
}

/** Individual health check item */
export interface HealthCheckItem {
    /** Check name */
    name: string;
    /** Whether this check passed */
    passed: boolean;
    /** Status message */
    message: string;
    /** Severity if failed */
    severity?: 'error' | 'warning';
    /** Suggested fix */
    suggestion?: string;
}

/** Configuration validation result */
export interface ConfigValidationResult {
    /** Whether configuration is valid */
    valid: boolean;
    /** Validation errors */
    errors: ConfigValidationError[];
    /** Validation warnings */
    warnings: ConfigValidationWarning[];
}

/** Configuration validation error */
export interface ConfigValidationError {
    /** Field that failed validation */
    field: string;
    /** Error message */
    message: string;
    /** Current value */
    value?: string;
}

/** Configuration validation warning */
export interface ConfigValidationWarning {
    /** Field with warning */
    field: string;
    /** Warning message */
    message: string;
    /** Current value */
    value?: string;
}

/** Backend service interface */
export interface NukeCoreBackendServiceInterface {
    /** Set Python configuration */
    setConfig(config: PythonConfig): Promise<void>;
    
    /** Get current configuration */
    getConfig(): Promise<PythonConfig>;
    
    /** Detect Python command based on current config */
    detectPython(): Promise<PythonDetectionResult>;
    
    /**
     * Detect Python with specific package requirements.
     * This will find a Python environment that has all required packages.
     */
    detectPythonWithRequirements(options: PythonDetectionOptions): Promise<PythonDetectionResult & { missingPackages?: string[] }>;
    
    /** 
     * Check if specific packages are available in a Python environment.
     * If pythonPath is not provided, uses the currently configured/detected Python.
     */
    checkDependencies(packages: PackageDependency[], pythonPath?: string): Promise<DependencyCheckResult>;
    
    /** List available Python environments */
    listEnvironments(searchWorkspace?: boolean): Promise<ListEnvironmentsResult>;
    
    /** Get the Python command to use (cached detection result) */
    getPythonCommand(): Promise<string | undefined>;

    /**
     * Validate configuration settings.
     * Checks if paths exist and are valid.
     */
    validateConfig(): Promise<ConfigValidationResult>;

    /**
     * Run health checks on the Nuke Core setup.
     * @param packages Optional packages to check for (e.g., ['openmc', 'numpy'])
     */
    healthCheck(packages?: string[]): Promise<HealthCheckResult>;

    /**
     * Get detailed diagnostics information for troubleshooting.
     */
    getDiagnostics(): Promise<Record<string, unknown>>;

    /**
     * Create a new Python environment (conda or venv).
     */
    createEnvironment(options: CreateEnvironmentOptions): Promise<CreateEnvironmentResult>;

    /**
     * Prepare a shell command for creating an environment.
     * Used by the frontend to run the command in a terminal widget for live output.
     */
    prepareCreateEnvironmentCommand(options: CreateEnvironmentOptions): Promise<CreateEnvironmentCommand>;

    /**
     * Prepare a shell command for installing packages.
     * Used by the frontend to run the command in a terminal widget for live output.
     */
    prepareInstallPackagesCommand(options: PackageInstallOptions): Promise<{ command: string; cwd: string }>;

    /**
     * Get the best available conda/mamba command.
     * Returns undefined if neither is installed.
     */
    getCondaCommand(): Promise<{ cmd: string; type: 'conda' | 'mamba' } | undefined>;

    /**
     * Delete a user-created environment.
     * Only conda envs in ~/.nuke-ide/envs/ and venvs are deletable.
     */
    deleteEnvironment(env: NukeEnvironment): Promise<{ success: boolean; error?: string }>;
}

/** Frontend event types */
export interface NukeEnvironmentChangedEvent {
    /** Previous environment */
    previous?: PythonConfig;
    /** New environment */
    current: PythonConfig;
    /** Previous environment info */
    previousEnv?: NukeEnvironment;
    /** New environment info */
    currentEnv?: NukeEnvironment;
}

/** Event fired when Python environment detection falls back to a different environment */
export interface EnvironmentFallbackEvent {
    /** The configured environment that was requested (if any) */
    requestedEnv?: string;
    /** The environment that was actually used */
    fallbackEnv: NukeEnvironment;
    /** Warning message explaining the fallback */
    warning: string;
    /** Packages that were required */
    requiredPackages: string[];
}

/** Status bar state */
export interface EnvironmentStatus {
    /** Whether environment is configured */
    configured: boolean;
    /** Current environment info */
    environment?: NukeEnvironment;
    /** Fallback environment (when configured env lacks required packages) */
    fallbackEnvironment?: NukeEnvironment;
    /** Status message */
    message: string;
    /** Whether environment is ready for use */
    ready: boolean;
    /** Whether status bar visibility is being requested by any extension */
    visibilityRequested: boolean;
}

/** 
 * Symbol for the status bar visibility service.
 * Extensions can use this to request status bar visibility when their tools are active.
 */
export const NukeCoreStatusBarVisibility = Symbol('NukeCoreStatusBarVisibility');

/**
 * Service for managing status bar visibility requests from dependent extensions.
 * 
 * Example usage:
 * ```typescript
 * // In your extension's widget or contribution
 * @inject(NukeCoreStatusBarVisibility)
 * private readonly visibility: NukeCoreStatusBarVisibilityService;
 * 
 * // When your tool opens
 * const handle = this.visibility.requestVisibility('my-extension');
 * 
 * // When your tool closes
 * handle.dispose();
 * ```
 */
export interface NukeCoreStatusBarVisibilityService {
    /**
     * Request the status bar to be visible.
     * @param source Identifier for the extension requesting visibility (e.g., 'nuke-visualizer')
     * @returns A disposable handle. Call dispose() when visibility is no longer needed.
     */
    requestVisibility(source: string): { dispose: () => void };
    
    /**
     * Check if any extension is currently requesting visibility.
     */
    isVisibilityRequested(): boolean;
    
    /**
     * Event fired when visibility requests change.
     */
    onVisibilityChanged: Event<boolean>;
}
