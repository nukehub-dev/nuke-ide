// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0
// *****************************************************************************

/**
 * Nuke Core Node Services – Barrel Module
 *
 * Re-exports all backend domain services so that consumers can import them
 * from a single entry point:
 *
 * ```ts
 * import { EnvironmentService, PackageService, HealthService } from './services';
 * ```
 *
 * Available services:
 * - {@link EnvironmentService} – Python environment detection, creation, and management
 * - {@link PackageService}     – Package installation command preparation
 * - {@link HealthService}      – Health checks, config validation, and diagnostics
 *
 * @module nuke-core/node/services
 */

export * from './environment/environment-service';
export * from './package-service';
export * from './health-service';
