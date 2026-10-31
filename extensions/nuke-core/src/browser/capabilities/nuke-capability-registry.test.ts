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

import { describe, it, expect, vi } from 'vitest';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { ILogger } from '@theia/core/lib/common/logger';
import {
    NukeCapability,
    NukeCapabilityContribution,
    NukeCapabilityContext,
    NukeCapabilityRisk,
    NukeJsonSchema
} from '../../common/nuke-capability-protocol';
import {
    NukeCapabilityRegistryImpl,
    deriveAnnotations,
    isWithinWorkspace,
    validateCapability,
    validateCapabilityInput
} from './nuke-capability-registry';

function createLogger(): ILogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    return {
        error: vi.fn(),
        warn: vi.fn()
    } as unknown as ILogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}

function capability(overrides: Partial<NukeCapability> = {}): NukeCapability {
    return {
        id: 'nuke.example.describe',
        title: 'Describe',
        description: 'Describe the current state.',
        category: ['Example'],
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                count: { type: 'integer' },
                enabled: { type: 'boolean' }
            },
            required: ['path']
        },
        risk: 'read',
        invoke: async () => ({ ok: true }),
        ...overrides
    };
}

function createRegistry(contributions: NukeCapabilityContribution[] = []): {
    registry: NukeCapabilityRegistryImpl;
    logger: ReturnType<typeof createLogger>;
} {
    const logger = createLogger();
    const provider: ContributionProvider<NukeCapabilityContribution> = {
        getContributions: () => contributions
    };
    return { registry: new NukeCapabilityRegistryImpl(provider, logger), logger };
}

describe('NukeCapabilityRegistry', () => {
    it('accepts a valid capability and returns a deterministic order', () => {
        const { registry } = createRegistry();
        registry.register(capability({ id: 'nuke.example.zeta', title: 'Zeta', category: ['B'] }));
        registry.register(capability({ id: 'nuke.example.alpha', title: 'Alpha', category: ['A'] }));
        registry.register(capability({ id: 'nuke.example.beta', title: 'Beta', category: ['A'] }));

        expect(registry.getAll().map((entry) => entry.id)).toEqual(['nuke.example.alpha', 'nuke.example.beta', 'nuke.example.zeta']);
        expect(registry.get('nuke.example.alpha')?.title).toBe('Alpha');
    });

    it('rejects a duplicate id and keeps the first registration', () => {
        const { registry, logger } = createRegistry();
        registry.register(capability({ id: 'nuke.example.keep', title: 'First' }));
        registry.register(capability({ id: 'nuke.example.keep', title: 'Second' }));

        expect(registry.getAll()).toHaveLength(1);
        expect(registry.get('nuke.example.keep')?.title).toBe('First');
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('defaults a missing version to 1 and keeps valid versions', () => {
        const { registry } = createRegistry();
        registry.register(capability({ id: 'nuke.example.defaultVersion' }));
        registry.register(capability({ id: 'nuke.example.versioned', version: 3 }));

        expect(registry.get('nuke.example.defaultVersion')?.version).toBe(1);
        expect(registry.get('nuke.example.versioned')?.version).toBe(3);
    });

    it('rejects non-integer and non-positive versions', () => {
        const invalid: unknown[] = [0, -1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY];
        for (const version of invalid) {
            const { registry, logger } = createRegistry();
            registry.register(capability({ id: 'nuke.example.badVersion', version: version as number }));
            expect(registry.getAll()).toHaveLength(0);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('version must be an integer >= 1'));
        }
        expect(validateCapability(capability({ version: 0 }))).toContain('version must be an integer >= 1 when provided');
    });

    it('logs a duplicate id once and keeps the first registration', () => {
        const { registry, logger } = createRegistry();
        registry.register(capability({ id: 'nuke.example.duplicate', title: 'First' }));
        registry.register(capability({ id: 'nuke.example.duplicate', title: 'Second' }));
        registry.register(capability({ id: 'nuke.example.duplicate', title: 'Third' }));

        expect(registry.getAll()).toHaveLength(1);
        expect(registry.get('nuke.example.duplicate')?.title).toBe('First');
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Duplicate capability id nuke.example.duplicate'));
    });

    it('logs the first duplicate contribution collision once with both sources', async () => {
        class FirstContribution implements NukeCapabilityContribution {
            registerCapabilities(registry: NukeCapabilityRegistryImpl): void {
                registry.register(capability({ id: 'nuke.example.duplicateContribution', title: 'First' }));
            }
        }
        class SecondContribution implements NukeCapabilityContribution {
            registerCapabilities(registry: NukeCapabilityRegistryImpl): void {
                registry.register(capability({ id: 'nuke.example.duplicateContribution', title: 'Second' }));
            }
        }
        const { registry, logger } = createRegistry([new FirstContribution(), new SecondContribution()]);

        await registry.initialize();

        expect(registry.get('nuke.example.duplicateContribution')?.title).toBe('First');
        expect(logger.error).toHaveBeenCalledTimes(1);
        const message = String(logger.error.mock.calls[0][0]);
        expect(message).toContain('contribution FirstContribution');
        expect(message).toContain('contribution SecondContribution');
    });

    it('rejects invalid ids, schemas, risks, and invoke handlers', () => {
        const invalid: NukeCapability[] = [
            capability({ id: 'nuke.bad' }),
            capability({ title: '   ' }),
            capability({ inputSchema: { type: 'object' } as NukeJsonSchema }),
            capability({ inputSchema: { type: 'array', properties: {} } as unknown as NukeJsonSchema }),
            capability({ risk: 'dangerous' as unknown as NukeCapabilityRisk }),
            capability({ invoke: 'not a function' as unknown as NukeCapability['invoke'] })
        ];
        for (const entry of invalid) {
            const { registry, logger } = createRegistry();
            registry.register(entry);
            expect(registry.getAll()).toHaveLength(0);
            expect(logger.error).toHaveBeenCalledTimes(1);
        }
    });

    it('getEnabled honors when predicates', () => {
        const { registry } = createRegistry();
        registry.register(
            capability({
                id: 'nuke.example.cadOnly',
                title: 'CAD only',
                when: (context) => context.activeCadDocument !== undefined
            })
        );
        registry.register(capability({ id: 'nuke.example.always', title: 'Always' }));

        const context: NukeCapabilityContext = { workspaceRoots: ['/workspace'] };
        expect(registry.getEnabled(context).map((entry) => entry.id)).toEqual(['nuke.example.always']);
        expect(registry.getEnabled({ ...context, activeCadDocument: '/workspace/model.CAD' }).map((entry) => entry.id)).toEqual([
            'nuke.example.always',
            'nuke.example.cadOnly'
        ]);
    });

    it('derives annotations for every risk level', () => {
        expect(deriveAnnotations('read')).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        });
        expect(deriveAnnotations('write')).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
        });
        expect(deriveAnnotations('execute')).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
        });
        expect(deriveAnnotations('destructive')).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        });
    });

    it('attaches derived annotations when omitted and warns on contradictions', () => {
        const { registry, logger } = createRegistry();
        registry.register(capability({ id: 'nuke.example.derived' }));
        expect(registry.get('nuke.example.derived')?.annotations).toEqual(deriveAnnotations('read'));

        registry.register(
            capability({
                id: 'nuke.example.explicit',
                risk: 'read',
                annotations: { readOnlyHint: false }
            })
        );
        expect(registry.get('nuke.example.explicit')?.annotations).toEqual({ readOnlyHint: false });
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('validates required keys and top-level primitive types', () => {
        const entry = capability({});
        expect(validateCapabilityInput(entry, { path: '/tmp/file', count: 2, enabled: true })).toEqual([]);
        expect(validateCapabilityInput(entry, {})).toContain('missing required input "path"');
        expect(validateCapabilityInput(entry, { path: 7, count: 1.5, enabled: 'yes' })).toEqual([
            'input "path" must be a string',
            'input "count" must be an integer',
            'input "enabled" must be a boolean'
        ]);
        expect(validateCapabilityInput(entry, null)).toEqual(['input must be an object']);
        expect(validateCapabilityInput(entry, [])).toEqual(['input must be an object']);
    });

    it('validates objects and arrays distinctly', () => {
        const entry = capability({
            inputSchema: {
                type: 'object',
                properties: {
                    options: { type: 'object' },
                    values: { type: 'array' }
                }
            }
        });
        expect(validateCapabilityInput(entry, { options: {}, values: [] })).toEqual([]);
        expect(validateCapabilityInput(entry, { options: [], values: {} })).toEqual([
            'input "options" must be an object',
            'input "values" must be an array'
        ]);
    });

    it('checks capability static validation directly', () => {
        expect(validateCapability(capability())).toEqual([]);
        expect(validateCapability(capability({ id: 'nuke.example.Verb' }))).toContain('id must match nuke.<domain>.<verbNoun>');
        expect(validateCapability(capability({ category: 'not-an-array' as unknown as string[] }))).toContain(
            'category must be an array of strings'
        );
    });

    it('accepts child paths and rejects siblings, traversal, and empty roots', () => {
        expect(isWithinWorkspace('/a/b/src/main.ts', ['/a/b'])).toBe(true);
        expect(isWithinWorkspace('/a/b', ['/a/b'])).toBe(true);
        expect(isWithinWorkspace('/a/bc', ['/a/b'])).toBe(false);
        expect(isWithinWorkspace('/a/b/../c', ['/a/b'])).toBe(false);
        expect(isWithinWorkspace('/a/b', ['/a/b', '/other'])).toBe(true);
        expect(isWithinWorkspace('/a/b', [])).toBe(false);
        expect(isWithinWorkspace('/a/b', [''])).toBe(false);
        expect(isWithinWorkspace('a/b', ['/a'])).toBe(false);
        expect(isWithinWorkspace('/a/b', ['relative/root'])).toBe(false);
    });

    it('a throwing contribution does not prevent later contributions from registering', async () => {
        class BrokenContribution implements NukeCapabilityContribution {
            registerCapabilities(registry: NukeCapabilityRegistryImpl): void {
                registry.register(capability({ id: 'nuke.example.first' }));
                throw new Error('broken contribution');
            }
        }
        class WorkingContribution implements NukeCapabilityContribution {
            registerCapabilities(registry: NukeCapabilityRegistryImpl): void {
                registry.register(capability({ id: 'nuke.example.second' }));
            }
        }
        const { registry, logger } = createRegistry([new BrokenContribution(), new WorkingContribution()]);

        await registry.initialize();

        expect(registry.getAll().map((entry) => entry.id)).toEqual(['nuke.example.first', 'nuke.example.second']);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('ready resolves even when a contribution throws', async () => {
        const broken: NukeCapabilityContribution = {
            registerCapabilities(): void {
                throw new Error('broken contribution');
            }
        };
        const { registry } = createRegistry([broken]);

        void registry.initialize();

        await expect(registry.ready).resolves.toBeUndefined();
    });

    it('fires a change event once after the initial pass and once per later registration', async () => {
        const contribution: NukeCapabilityContribution = {
            registerCapabilities(registry: NukeCapabilityRegistryImpl): void {
                registry.register(capability({ id: 'nuke.example.initial' }));
            }
        };
        const { registry } = createRegistry([contribution]);
        const listener = vi.fn();
        registry.onDidChange(listener);

        await registry.initialize();
        expect(listener).toHaveBeenCalledTimes(1);

        registry.register(capability({ id: 'nuke.example.later' }));
        expect(listener).toHaveBeenCalledTimes(2);

        registry.register(capability({ id: 'not-a-valid-id' }));
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('excludes capabilities whose when predicate throws', () => {
        const { registry, logger } = createRegistry();
        registry.register(
            capability({
                id: 'nuke.example.brokenWhen',
                when: () => {
                    throw new Error('predicate failed');
                }
            })
        );

        expect(registry.getEnabled({ workspaceRoots: ['/workspace'] })).toEqual([]);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });
});
