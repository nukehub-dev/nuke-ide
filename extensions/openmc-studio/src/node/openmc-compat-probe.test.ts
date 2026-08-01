// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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
 * Tests for the OpenMC version compatibility probe and the backend's
 * random ray XML format selection (probe mocked).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OpenMCCompatProbeService } from './openmc-compat-probe';
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { XMLGenerationService } from './xml-generation-service';
import { DEFAULT_RANDOM_RAY_COMPAT, RandomRayXmlCompat } from '../common/openmc-studio-protocol';
import { OpenMCState } from '../common/openmc-state-schema';

/** Probe subclass with the python spawn mocked out. */
class MockProbe extends OpenMCCompatProbeService {
    probeCalls: string[] = [];
    probeResult: RandomRayXmlCompat | undefined;

    protected runProbe(pythonCommand: string): RandomRayXmlCompat | undefined {
        this.probeCalls.push(pythonCommand);
        return this.probeResult;
    }
}

function makeProbe(pythonCommand: string | undefined, probeResult: RandomRayXmlCompat | undefined): MockProbe {
    const probe = new MockProbe();
    (probe as any).validationService = {
        validateOpenMCSetup: async () => ({
            ready: pythonCommand !== undefined,
            pythonCommand,
            errors: [],
            warnings: []
        })
    };
    probe.probeResult = probeResult;
    return probe;
}

function buildRandomRayState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'RR Probe Test', created: now, modified: now },
        geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
        materials: [],
        settings: {
            run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 },
            sources: [],
            energyMode: 'multigroup',
            mgxsLibrary: '/data/mgxs.h5',
            randomRay: {
                distanceInactive: 50,
                distanceActive: 250,
                raySource: { lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] }
            }
        },
        tallies: [],
        meshes: [],
        plots: []
    } as OpenMCState;
}

describe('OpenMCCompatProbeService', () => {
    it('parses the release probe output (direct, no adjoint)', async () => {
        const probe = makeProbe('/fake/python', undefined);
        expect((probe as any).parseProbeOutput('direct no-adjoint\n')).toEqual({
            raySourceFormat: 'direct',
            adjointSource: false
        });
    });

    it('parses the dev probe output (wrapper, adjoint)', async () => {
        const probe = makeProbe('/fake/python', undefined);
        expect((probe as any).parseProbeOutput('wrapper adjoint\n')).toEqual({
            raySourceFormat: 'wrapper',
            adjointSource: true
        });
    });

    it('rejects malformed probe output', () => {
        const probe = makeProbe('/fake/python', undefined);
        expect((probe as any).parseProbeOutput('openmc 0.15.3\n')).toBeUndefined();
        expect((probe as any).parseProbeOutput('')).toBeUndefined();
    });

    it('returns the probed format and caches it per python command', async () => {
        const probe = makeProbe('/fake/python', { raySourceFormat: 'wrapper', adjointSource: true });
        const first = await probe.getRandomRayCompat();
        const second = await probe.getRandomRayCompat();
        expect(first).toEqual({ raySourceFormat: 'wrapper', adjointSource: true });
        expect(second).toEqual(first);
        expect(probe.probeCalls).toEqual(['/fake/python']);
    });

    it('falls back to the release-compatible default on probe failure', async () => {
        const probe = makeProbe('/fake/python', undefined);
        expect(await probe.getRandomRayCompat()).toEqual(DEFAULT_RANDOM_RAY_COMPAT);
    });

    it('falls back to the default when no environment is configured', async () => {
        const probe = makeProbe(undefined, { raySourceFormat: 'wrapper', adjointSource: true });
        expect(await probe.getRandomRayCompat()).toEqual(DEFAULT_RANDOM_RAY_COMPAT);
        expect(probe.probeCalls).toEqual([]);
    });

    it('caches per python command, not globally', async () => {
        const probe = makeProbe('/fake/python-a', { raySourceFormat: 'direct', adjointSource: false });
        await probe.getRandomRayCompat();
        (probe as any).validationService = {
            validateOpenMCSetup: async () => ({ ready: true, pythonCommand: '/fake/python-b', errors: [], warnings: [] })
        };
        probe.probeResult = { raySourceFormat: 'wrapper', adjointSource: true };
        const second = await probe.getRandomRayCompat();
        expect(second).toEqual({ raySourceFormat: 'wrapper', adjointSource: true });
        expect(probe.probeCalls).toEqual(['/fake/python-a', '/fake/python-b']);
    });
});

describe('OpenMCStudioBackendServiceImpl random ray format selection', () => {
    it('injects the probed format into generateXML', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-compat-'));
        try {
            const backend = new OpenMCStudioBackendServiceImpl();
            (backend as any).xmlService = new XMLGenerationService();
            (backend as any).compatProbe = makeProbe('/fake/python', { raySourceFormat: 'wrapper', adjointSource: true });

            await backend.generateXML({
                state: buildRandomRayState(),
                outputDirectory: tempDir,
                files: { materials: false, geometry: false, settings: true, tallies: false, plots: false }
            });

            const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
            expect(xml).toContain('<ray_source>');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('does not override an explicitly supplied format', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-compat-'));
        try {
            const backend = new OpenMCStudioBackendServiceImpl();
            (backend as any).xmlService = new XMLGenerationService();
            const probe = makeProbe('/fake/python', { raySourceFormat: 'wrapper', adjointSource: true });
            (backend as any).compatProbe = probe;

            await backend.generateXML({
                state: buildRandomRayState(),
                outputDirectory: tempDir,
                files: { materials: false, geometry: false, settings: true, tallies: false, plots: false },
                randomRayCompat: { raySourceFormat: 'direct', adjointSource: false }
            });

            const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
            expect(xml).not.toContain('<ray_source>');
            expect(probe.probeCalls).toEqual([]);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
