// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * OpenMC Studio Common Module
 * 
 * Re-exports all types, interfaces, and protocol definitions from the common module.
 * This is the shared contract between the frontend and backend of OpenMC Studio.
 * 
 * @module openmc-studio/common
 * @see {@link ./openmc-state-schema} Simulation state schema definitions
 * @see {@link ./openmc-studio-protocol} RPC protocol and service interfaces
 */

export * from './openmc-state-schema';
export * from './openmc-studio-protocol';
