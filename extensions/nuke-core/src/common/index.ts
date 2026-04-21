// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Barrel module for nuke-core common exports.
 *
 * Re-exports all protocol types, symbols, and interfaces from the core protocol,
 * along with backward-compatible service references.
 *
 * @module nuke-core/common
 */
export * from './nuke-core-protocol';

// Re-export backend service interface
export { NukeCoreBackendServiceInterface, NukeCoreBackendService } from './nuke-core-protocol';

// Re-export browser service (for backward compatibility)
export { NukeCoreService } from '../browser/services/nuke-core-service';
