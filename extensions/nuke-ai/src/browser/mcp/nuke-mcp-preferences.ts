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
 * Nuke MCP Preferences
 *
 * User-scoped settings for the opt-in external MCP endpoint. The backend reads
 * `<configDir>/nuke-ai-mcp.json` instead of these preferences, so a change to
 * either the enable command or the file takes effect without a restart.
 *
 * @module nuke-ai/browser/mcp
 */

import { interfaces } from '@theia/core/shared/inversify';
import { PreferenceContribution, PreferenceSchema, PreferenceScope } from '@theia/core/lib/common/preferences';

/** Default loopback port for the external MCP endpoint. */
export const NUKE_MCP_DEFAULT_PORT = 3210;

/** Preference schema for the external MCP endpoint. */
export const NukeMcpPreferenceSchema: PreferenceSchema = {
    properties: {
        'nuke.ai.mcp.enabled': {
            type: 'boolean',
            default: false,
            scope: PreferenceScope.User,
            description: 'Enable the token-protected, loopback-only MCP endpoint for external agents.'
        },
        'nuke.ai.mcp.port': {
            type: 'number',
            default: NUKE_MCP_DEFAULT_PORT,
            minimum: 1,
            maximum: 65535,
            scope: PreferenceScope.User,
            description: 'Loopback port used by the external MCP endpoint when enabled.'
        }
    }
};

/** Typed configuration interface mirroring the MCP preference schema. */
export interface NukeMcpConfiguration {
    'nuke.ai.mcp.enabled': boolean;
    'nuke.ai.mcp.port': number;
}

/** Symbol used to bind the MCP preference contribution. */
export const NukeMcpPreferenceContribution = Symbol('NukeMcpPreferenceContribution');

/** Bind the MCP preference schema into the frontend container. */
export function bindNukeMcpPreferences(bind: interfaces.Bind): void {
    bind(NukeMcpPreferenceContribution).toConstantValue({ schema: NukeMcpPreferenceSchema });
    bind(PreferenceContribution).toService(NukeMcpPreferenceContribution);
}
