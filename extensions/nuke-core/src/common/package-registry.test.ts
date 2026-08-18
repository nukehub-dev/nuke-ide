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
 * Drift guard for the extension `packages.json` files.
 *
 * `package-registry.json` is the canonical source of install spec fields
 * (`submodule`, `condaOnly`, `channels`, `extraIndexUrl`, `pipSpec`, `pipArgs`,
 * `condaSpec`) for Python packages shared by nuke-cad, nuke-visualizer, and
 * openmc-studio. Every registry-listed package must carry exactly the registry
 * spec wherever it appears (`required`/`minVersion` stay per-group context),
 * and any package name appearing in more than one extension must be registered.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'extensions/nuke-core/src/common/package-registry.json');
const EXTENSION_PACKAGES = ['nuke-cad', 'nuke-visualizer', 'openmc-studio'].map((ext) => ({
    extension: ext,
    file: path.join(REPO_ROOT, 'extensions', ext, 'src/common/packages.json')
}));

/** Spec fields pinned by the registry; `required`/`minVersion` are per-group context. */
const SPEC_FIELDS = ['submodule', 'condaOnly', 'channels', 'extraIndexUrl', 'pipSpec', 'pipArgs', 'condaSpec'] as const;

type PackageEntry = { name: string } & Record<string, unknown>;

function loadJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function loadRegistry(): Record<string, Record<string, unknown>> {
    const raw = loadJson(REGISTRY_PATH);
    const registry: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(raw)) {
        if (!name.startsWith('$')) {
            registry[name] = spec as Record<string, unknown>;
        }
    }
    return registry;
}

/** All dependency entries of a packages.json, tagged with their group. */
function entriesOf(file: string): Array<{ group: string; entry: PackageEntry }> {
    const groups = loadJson(file) as Record<string, PackageEntry[]>;
    return Object.entries(groups).flatMap(([group, entries]) => entries.map((entry) => ({ group, entry })));
}

/** Spec-field projection of an entry (absent fields normalized to undefined). */
function specOf(entry: Record<string, unknown>): Record<string, unknown> {
    const spec: Record<string, unknown> = {};
    for (const field of SPEC_FIELDS) {
        spec[field] = entry[field] ?? undefined;
    }
    return spec;
}

describe('package registry consistency', () => {
    const registry = loadRegistry();

    it('registry-listed packages match the registry spec in every extension', () => {
        const mismatches: string[] = [];
        for (const { extension, file } of EXTENSION_PACKAGES) {
            for (const { group, entry } of entriesOf(file)) {
                const expected = registry[entry.name];
                if (!expected) {
                    continue;
                }
                const actual = specOf(entry);
                const wanted = specOf(expected);
                try {
                    expect(actual).toEqual(wanted);
                } catch {
                    mismatches.push(`${extension} ${group}/${entry.name}`);
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    it('packages shared by more than one extension are registered', () => {
        const seen = new Map<string, string[]>();
        for (const { extension, file } of EXTENSION_PACKAGES) {
            for (const name of new Set(entriesOf(file).map((e) => e.entry.name))) {
                seen.set(name, [...(seen.get(name) ?? []), extension]);
            }
        }
        const unregistered = [...seen.entries()]
            .filter(([, extensions]) => extensions.length > 1)
            .filter(([name]) => !(name in registry))
            .map(([name, extensions]) => `${name} (${extensions.join(', ')})`);
        expect(unregistered).toEqual([]);
    });
});
