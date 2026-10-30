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

import { describe, it, expect } from 'vitest';
import { OpenMCSettings } from '../common/openmc-state-schema';
import { validateRuntimeSettings } from '../common/settings-validation';
import { DEFAULT_OPENMC_COMPAT } from '../common/openmc-studio-protocol';

/** Minimal eigenvalue settings for validation tests. */
function settings(overrides: Partial<OpenMCSettings> = {}): OpenMCSettings {
    return {
        run: { mode: 'eigenvalue', particles: 100, inactive: 10, batches: 50 },
        sources: [],
        ...overrides
    };
}

describe('validateRuntimeSettings', () => {
    it('accepts an empty advanced configuration', () => {
        expect(validateRuntimeSettings(settings())).toEqual([]);
    });

    it('rejects non-positive threads and MPI process counts', () => {
        expect(validateRuntimeSettings(settings({ threads: 0 }))[0]).toMatchObject({ group: 'execution', severity: 'error' });
        expect(validateRuntimeSettings(settings({ mpi: { enabled: true, processes: 0 } }))[0]).toMatchObject({
            group: 'execution',
            severity: 'error'
        });
    });

    it('warns for a single MPI rank and empty host entries', () => {
        expect(validateRuntimeSettings(settings({ mpi: { enabled: true, processes: 1 } }))[0]).toMatchObject({
            group: 'execution',
            severity: 'warning'
        });
        expect(validateRuntimeSettings(settings({ mpi: { enabled: true, processes: 2, hosts: ['node1', ''] } }))[0]).toMatchObject({
            group: 'execution',
            severity: 'error'
        });
    });

    it('requires a full positive trace triple', () => {
        expect(validateRuntimeSettings(settings({ trace: [1, 1, 0] }))[0]).toMatchObject({ group: 'execution', severity: 'error' });
    });

    it('validates the k-eff trigger threshold and mode', () => {
        expect(validateRuntimeSettings(settings({ keffTrigger: { type: 'rel_err', threshold: 0 } }))[0]).toMatchObject({
            group: 'convergence',
            severity: 'error'
        });
        expect(
            validateRuntimeSettings(
                settings({ run: { mode: 'fixed source', particles: 100, batches: 10 }, keffTrigger: { type: 'rel_err', threshold: 0.01 } })
            )[0]
        ).toMatchObject({ group: 'convergence', severity: 'warning' });
    });

    it('rejects multipole together with photon transport', () => {
        const findings = validateRuntimeSettings(settings({ photonTransport: true, temperature: { multipole: true } }));
        expect(findings.some((finding) => finding.message.includes('multipole'))).toBe(true);
    });

    it('validates resonance ranges, free-gas, cutoffs, and grazing bounds', () => {
        const findings = validateRuntimeSettings(
            settings({
                resonanceScattering: { enable: true, energyMin: 1000, energyMax: 0.01 },
                freeGasThreshold: 0,
                cutoff: { energyNeutron: -1, time: 0, weight: 0 },
                surfaceGrazingCutoff: 1.5,
                surfaceGrazingRatio: -1
            })
        );
        const messages = findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message);
        expect(messages.some((message) => message.includes('Resonance-scattering'))).toBe(true);
        expect(messages.some((message) => message.includes('Free-gas'))).toBe(true);
        expect(messages.some((message) => message.includes('Neutron energy cutoff'))).toBe(true);
        expect(messages.some((message) => message.includes('Surface grazing cutoff'))).toBe(true);
        expect(messages.some((message) => message.includes('Surface grazing ratio'))).toBe(true);
    });

    it('validates limit and diagnostic ranges', () => {
        const findings = validateRuntimeSettings(
            settings({
                maxParticleEvents: 0,
                maxWriteLostParticles: -1,
                verbosity: 11,
                stride: 0,
                plotSeed: 0
            })
        );
        expect(findings.filter((finding) => finding.group === 'limits')).toHaveLength(2);
        expect(findings.filter((finding) => finding.group === 'diagnostics')).toHaveLength(3);
    });

    it('warns when 0.16-only settings are configured on a release environment', () => {
        const findings = validateRuntimeSettings(
            settings({ sharedSecondaryBank: true, surfaceGrazingCutoff: 0.001, surfaceGrazingRatio: 0.5 }),
            DEFAULT_OPENMC_COMPAT
        );
        expect(findings.filter((finding) => finding.severity === 'warning')).toHaveLength(2);
        expect(findings.every((finding) => finding.group === 'physics')).toBe(true);
    });
});
