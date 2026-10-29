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
 * OpenMC Version Compatibility Probe
 *
 * One-shot runtime probe of the configured python environment's OpenMC
 * capabilities (never version parsing):
 *
 * - `raySourceFormat` — the random ray `ray_source` XML format (direct
 *   `<source>` in OpenMC 0.15.3 vs the `<ray_source>` wrapper in 0.16.0+),
 *   detected from what `Settings.to_xml_element()` actually writes
 * - `adjointSource` — random ray adjoint source support (0.16.0+)
 * - `tokamakSource` — `openmc.TokamakSource` existence (0.16.0+)
 * - `decaySpectrum` — `openmc.stats.DecaySpectrum` existence (0.16.0+)
 * - `s2SampleMethod` — random ray `sample_method: 's2'` acceptance
 * - `sharedSecondaryBank` — `Settings.shared_secondary_bank` existence (0.16.0+)
 * - `surfaceGrazing` — `Settings.surface_grazing_cutoff` existence (0.16.0+)
 * - `meshFilterRotation` — `openmc.MeshFilter.rotation` existence (0.16.0+)
 * - `sourceBias` — `openmc.stats.Uniform(..., bias=...)` support (0.16.0+)
 * - `reactionFilter` — `openmc.ReactionFilter` existence (0.16.0+)
 * - `particleProductionFilter` — `openmc.ParticleProductionFilter` existence (0.16.0+)
 * - `generalizedParticles` — PDG-backed `openmc.ParticleType` accepting `He4` (0.16.0+)
 *
 * Results are cached per python command; on any probe failure the
 * release-compatible default is returned (stable releases are the common case).
 *
 * @module openmc-studio/node
 */

import * as cp from 'child_process';
import { injectable, inject } from '@theia/core/shared/inversify';
import { OpenMCCompat, DEFAULT_OPENMC_COMPAT } from '../common/openmc-studio-protocol';
import { OpenMCValidationBackendService } from './openmc-validation-backend-service';

/**
 * Python one-liner: prints fifteen space-separated tokens —
 * `<direct|wrapper> <adjoint|no-adjoint> <tokamak|no-tokamak> <s2|no-s2>
 * <substeps|no-substeps> <keff-search|no-keff-search>
 * <external-rate|no-external-rate> <continuation|no-continuation>
 * <shared-bank|no-shared-bank> <grazing|no-grazing> <decay|no-decay>
 * <mesh-rotation|no-mesh-rotation> <bias|no-bias>
 * <reaction-filter|no-reaction-filter> <particle-production|no-particle-production>
 * <generalized-particles|no-generalized-particles>`.
 *
 * Depletion, 0.16 settings, decay-spectrum, particle, and mesh-filter
 * capabilities are detected by introspection (never version strings):
 * constructor parameters, public Integrator methods, and
 * Settings/stats/MeshFilter/ParticleType attributes.
 */
const OPENMC_COMPAT_PROBE_SCRIPT = `
import inspect
import openmc
import openmc.deplete
s = openmc.Settings()
box = openmc.IndependentSource(space=openmc.stats.Box([-1,-1,-1],[1,1,1]))
s.random_ray = {'ray_source': box}
fmt = 'wrapper' if s.to_xml_element().find('random_ray').find('ray_source') is not None else 'direct'
try:
    s.random_ray = {'ray_source': box, 'adjoint_source': box}
    adj = True
except Exception:
    adj = False
try:
    s.random_ray = {'ray_source': box, 'sample_method': 's2'}
    s2 = True
except Exception:
    s2 = False
tok = hasattr(openmc, 'TokamakSource')
try:
    from openmc.deplete.abc import Integrator as _Integrator
except Exception:
    _Integrator = getattr(openmc.deplete, 'Integrator', None)
try:
    _params = inspect.signature(_Integrator.__init__).parameters if _Integrator else {}
except Exception:
    _params = {}
substeps = 'substeps' in _params
keff_search = bool(_Integrator is not None and hasattr(_Integrator, 'add_keff_search_control'))
external_rate = bool(_Integrator is not None and hasattr(_Integrator, 'add_external_source_rate'))
continuation = 'continue_timesteps' in _params and hasattr(openmc.deplete, 'Results')
shared_bank = hasattr(openmc.Settings(), 'shared_secondary_bank')
grazing = hasattr(openmc.Settings(), 'surface_grazing_cutoff')
decay = hasattr(openmc.stats, 'DecaySpectrum')
mesh_rotation = hasattr(openmc.MeshFilter, 'rotation')
bias = 'bias' in inspect.signature(openmc.stats.Uniform.__init__).parameters
reaction_filter = hasattr(openmc, 'ReactionFilter')
particle_production = hasattr(openmc, 'ParticleProductionFilter')
try:
    generalized_particles = (
        hasattr(openmc.ParticleType, 'pdg_number')
        and str(openmc.ParticleType('He4')) == 'He4'
        and openmc.ParticleType('He4').pdg_number == 1000020040
    )
except Exception:
    generalized_particles = False
print('{} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {}'.format(
    fmt,
    'adjoint' if adj else 'no-adjoint',
    'tokamak' if tok else 'no-tokamak',
    's2' if s2 else 'no-s2',
    'substeps' if substeps else 'no-substeps',
    'keff-search' if keff_search else 'no-keff-search',
    'external-rate' if external_rate else 'no-external-rate',
    'continuation' if continuation else 'no-continuation',
    'shared-bank' if shared_bank else 'no-shared-bank',
    'grazing' if grazing else 'no-grazing',
    'decay' if decay else 'no-decay',
    'mesh-rotation' if mesh_rotation else 'no-mesh-rotation',
    'bias' if bias else 'no-bias',
    'reaction-filter' if reaction_filter else 'no-reaction-filter',
    'particle-production' if particle_production else 'no-particle-production',
    'generalized-particles' if generalized_particles else 'no-generalized-particles'))
`;

const PROBE_TIMEOUT_MS = 30000;

@injectable()
export class OpenMCCompatProbeService {
    @inject(OpenMCValidationBackendService)
    protected readonly validationService: OpenMCValidationBackendService;

    /** Probe results, keyed by python command path. */
    private readonly cache = new Map<string, OpenMCCompat>();

    /**
     * Resolve the OpenMC compatibility for the configured python environment,
     * probing once per python command and caching the result. Falls back to
     * the release-compatible default when no environment is configured or the
     * probe fails.
     * @returns OpenMC compatibility descriptor
     */
    async getOpenMCCompat(): Promise<OpenMCCompat> {
        let pythonCommand: string | undefined;
        try {
            const validation = await this.validationService.validateOpenMCSetup();
            pythonCommand = validation.ready ? validation.pythonCommand : undefined;
        } catch {
            // Environment detection failed — fall through to the default
        }
        if (!pythonCommand) {
            return DEFAULT_OPENMC_COMPAT;
        }
        const cached = this.cache.get(pythonCommand);
        if (cached) {
            return cached;
        }
        const compat = (await this.runProbe(pythonCommand)) ?? DEFAULT_OPENMC_COMPAT;
        this.cache.set(pythonCommand, compat);
        console.log(`[OpenMC Compat Probe] ${pythonCommand}: ${JSON.stringify(compat)}`);
        return compat;
    }

    /**
     * Run the probe script against a python command without blocking the
     * backend event loop (other JSON-RPC requests must stay responsive while
     * Python starts up).
     * @param pythonCommand - Python executable path
     * @returns Probe result, or undefined on any failure
     */
    protected async runProbe(pythonCommand: string): Promise<OpenMCCompat | undefined> {
        return new Promise<OpenMCCompat | undefined>((resolve) => {
            let stdout = '';
            let settled = false;
            const finish = (value: OpenMCCompat | undefined) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const child = cp.spawn(pythonCommand, ['-c', OPENMC_COMPAT_PROBE_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
            const timer = setTimeout(() => {
                child.kill();
                finish(undefined);
            }, PROBE_TIMEOUT_MS);
            child.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString();
            });
            child.on('error', () => finish(undefined));
            child.on('close', (code) => finish(code === 0 ? this.parseProbeOutput(stdout) : undefined));
        });
    }

    /**
     * Parse the probe's sixteen-token output line. Tokens after the original
     * four are optional so older probe output still parses (falling back to
     * the release-compatible defaults for missing capabilities).
     * @param stdout - Probe stdout
     * @returns Parsed compatibility, or undefined if malformed
     */
    protected parseProbeOutput(stdout: string): OpenMCCompat | undefined {
        const line = stdout
            .trim()
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .pop();
        const [
            format,
            adjoint,
            tokamak,
            s2,
            substeps,
            keffSearch,
            externalRate,
            continuation,
            sharedBank,
            grazing,
            decay,
            meshRotation,
            bias,
            reactionFilter,
            particleProduction,
            generalizedParticles
        ] = (line ?? '').split(/\s+/);
        if (format !== 'direct' && format !== 'wrapper') {
            return undefined;
        }
        return {
            raySourceFormat: format,
            adjointSource: adjoint === 'adjoint',
            tokamakSource: tokamak === 'tokamak',
            decaySpectrum: decay === 'decay',
            s2SampleMethod: s2 === 's2',
            depletionSubsteps: substeps === 'substeps',
            depletionKeffSearch: keffSearch === 'keff-search',
            depletionExternalSourceRate:
                externalRate === 'external-rate' || (!externalRate && DEFAULT_OPENMC_COMPAT.depletionExternalSourceRate),
            depletionContinuation: continuation === 'continuation' || (!continuation && DEFAULT_OPENMC_COMPAT.depletionContinuation),
            sharedSecondaryBank: sharedBank === 'shared-bank',
            surfaceGrazing: grazing === 'grazing',
            meshFilterRotation: meshRotation === 'mesh-rotation',
            sourceBias: bias === 'bias',
            reactionFilter: reactionFilter === 'reaction-filter',
            particleProductionFilter: particleProduction === 'particle-production',
            generalizedParticles: generalizedParticles === 'generalized-particles'
        };
    }
}
