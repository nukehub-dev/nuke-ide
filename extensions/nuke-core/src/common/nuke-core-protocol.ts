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

export const NUKE_CORE_BACKEND_PATH = '/services/nuke-core';

/** Symbol for the backend service */
export const NukeCoreBackendService = Symbol('NukeCoreBackendService');

/** Python configuration */
export interface PythonConfig {
    /** Path to Python executable */
    pythonPath?: string;
    /** Conda environment name */
    condaEnv?: string;
}

/** Information about a Python environment */
export interface PythonEnvironment {
    /** Display name */
    name: string;
    /** Python executable path */
    pythonPath: string;
    /** Type of environment */
    type: 'system' | 'conda' | 'venv' | 'pyenv';
    /** Python version (e.g., "3.10.4") */
    version?: string;
    /** Whether OpenMC is available in this environment */
    hasOpenMC?: boolean;
    /** OpenMC version if available */
    openmcVersion?: string;
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
}

/** Result of listing environments */
export interface ListEnvironmentsResult {
    /** Available environments */
    environments: PythonEnvironment[];
    /** Currently selected environment */
    selected?: PythonEnvironment;
}

/** Package dependency to check */
export interface PackageDependency {
    /** Package name to import (e.g., 'trame', 'openmc') */
    name: string;
    /** Optional submodule path for version check (e.g., 'app' for trame.app) */
    submodule?: string;
    /** Whether this package is required or optional */
    required?: boolean;
}

/** Result of dependency check */
export interface DependencyCheckResult {
    /** Whether all required packages are available */
    available: boolean;
    /** List of missing required packages */
    missing: string[];
    /** Package versions that were found */
    versions: Record<string, string>;
}

/** Extended Python detection with required packages */
export interface PythonDetectionOptions {
    /** Required packages that must be present */
    requiredPackages?: PackageDependency[];
    /** Conda environment names to try for auto-detection (in order) */
    autoDetectEnvs?: string[];
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
    listEnvironments(): Promise<ListEnvironmentsResult>;
    
    /** Get the Python command to use (cached detection result) */
    getPythonCommand(): Promise<string | undefined>;
}

/** Frontend event types */
export interface PythonEnvironmentChangedEvent {
    /** Previous environment */
    previous?: PythonConfig;
    /** New environment */
    current: PythonConfig;
}
