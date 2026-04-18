// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

// Common protocol exports
export * from './nuke-core-protocol';

// Re-export backend service interface
export { NukeCoreBackendServiceInterface, NukeCoreBackendService } from './nuke-core-protocol';

// Re-export browser service (for backward compatibility)
export { NukeCoreService } from '../browser/services/nuke-core-service';
