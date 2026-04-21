// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0
// *****************************************************************************

/**
 * Nuke Core Browser Services
 *
 * Barrel module that re-exports all browser-side services for the Nuke Core extension:
 * - {@link NukeCoreService} – core environment/configuration service
 * - {@link NukeCoreVisibilityService} – status bar visibility coordination
 * - {@link EnvironmentActionsHelper} – shared UI action helpers
 *
 * @module nuke-core/browser/services
 */

export * from './nuke-core-service';
export * from './nuke-core-visibility-service';
export * from './environment-actions-helper';
