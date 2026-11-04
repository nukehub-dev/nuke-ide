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
 * Nuke Capability Catalog
 *
 * Pure projection of {@link NukeCapability} registrations into the read-only
 * rows shown by the capability catalog command. It carries identity, risk,
 * version, tags, category, and availability only; handlers and schemas never
 * cross this boundary.
 *
 * @module nuke-core/browser/capabilities
 */

import { NukeCapability, NukeCapabilityContext, NukeCapabilityRisk } from '../../common/nuke-capability-protocol';

/** One read-only row in the capability catalog. */
export interface NukeCapabilityCatalogEntry {
    readonly id: string;
    readonly title: string;
    readonly risk: NukeCapabilityRisk;
    readonly version: number;
    readonly tags: readonly string[];
    readonly category: string;
    readonly available: boolean;
}

/** The effective contract version: capabilities without one are version 1. */
export function capabilityVersion(capability: Pick<NukeCapability, 'version'>): number {
    return capability.version ?? 1;
}

/**
 * Project capabilities into catalog rows.
 *
 * Pass `getEnabled(context)` results to omit unavailable capabilities, or the
 * full registry plus the same context to mark them unavailable instead. A
 * throwing `when` predicate is treated as unavailable.
 */
export function buildCapabilityCatalog(
    capabilities: readonly NukeCapability[],
    context?: NukeCapabilityContext
): NukeCapabilityCatalogEntry[] {
    return capabilities.map((capability) => ({
        id: capability.id,
        title: capability.title,
        risk: capability.risk,
        version: capabilityVersion(capability),
        tags: [...(capability.tags ?? [])],
        category: capability.category.join(' / '),
        available: context ? isAvailable(capability, context) : true
    }));
}

/** Read-only detail lines for one catalog entry. */
export function formatCapabilityDetails(entry: NukeCapabilityCatalogEntry, capability: NukeCapability): string[] {
    return [
        capability.description,
        '',
        `Id: ${entry.id}`,
        `Title: ${entry.title}`,
        `Version: ${entry.version}`,
        `Risk: ${entry.risk}`,
        `Category: ${entry.category || 'none'}`,
        `Tags: ${entry.tags.length > 0 ? entry.tags.join(', ') : 'none'}`,
        `Availability: ${entry.available ? 'available in the current context' : 'unavailable in the current context'}`
    ];
}

function isAvailable(capability: NukeCapability, context: NukeCapabilityContext): boolean {
    if (!capability.when) {
        return true;
    }
    try {
        return capability.when(context);
    } catch {
        return false;
    }
}
