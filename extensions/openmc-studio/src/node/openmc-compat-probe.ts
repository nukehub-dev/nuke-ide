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
 * One-shot probe of the configured python environment's OpenMC version
 * capabilities that affect settings.xml emission. Currently: the random ray
 * `ray_source` XML format (direct `<source>` in release 0.15.3 vs the
 * `<ray_source>` wrapper in post-0.15.3 dev) and adjoint source support
 * (post-0.15.3 only).
 *
 * Results are cached per python command; on any probe failure the
 * release-compatible default is returned (stable releases are the common case).
 *
 * @module openmc-studio/node
 */

import * as cp from 'child_process';
import { injectable, inject } from '@theia/core/shared/inversify';
import { RandomRayXmlCompat, DEFAULT_RANDOM_RAY_COMPAT } from '../common/openmc-studio-protocol';
import { OpenMCValidationBackendService } from './openmc-validation-backend-service';

/**
 * Python one-liner: prints `<direct|wrapper> <adjoint|no-adjoint>`.
 * The format check inspects what `Settings.to_xml_element()` actually writes;
 * the adjoint check relies on release 0.15.3 rejecting the `adjoint_source`
 * random_ray key with a ValueError.
 */
const RANDOM_RAY_PROBE_SCRIPT = `
import openmc
s = openmc.Settings()
box = openmc.IndependentSource(space=openmc.stats.Box([-1,-1,-1],[1,1,1]))
s.random_ray = {'ray_source': box}
fmt = 'wrapper' if s.to_xml_element().find('random_ray').find('ray_source') is not None else 'direct'
try:
    s.random_ray = {'ray_source': box, 'adjoint_source': box}
    adj = True
except Exception:
    adj = False
print(fmt + ' ' + ('adjoint' if adj else 'no-adjoint'))
`;

const PROBE_TIMEOUT_MS = 30000;

@injectable()
export class OpenMCCompatProbeService {
    @inject(OpenMCValidationBackendService)
    protected readonly validationService: OpenMCValidationBackendService;

    /** Probe results, keyed by python command path. */
    private readonly cache = new Map<string, RandomRayXmlCompat>();

    /**
     * Resolve the random ray XML compatibility for the configured python
     * environment, probing once per python command and caching the result.
     * Falls back to the release-compatible default when no environment is
     * configured or the probe fails.
     * @returns Random ray XML compatibility descriptor
     */
    async getRandomRayCompat(): Promise<RandomRayXmlCompat> {
        let pythonCommand: string | undefined;
        try {
            const validation = await this.validationService.validateOpenMCSetup();
            pythonCommand = validation.ready ? validation.pythonCommand : undefined;
        } catch {
            // Environment detection failed — fall through to the default
        }
        if (!pythonCommand) {
            return DEFAULT_RANDOM_RAY_COMPAT;
        }
        const cached = this.cache.get(pythonCommand);
        if (cached) {
            return cached;
        }
        const compat = this.runProbe(pythonCommand) ?? DEFAULT_RANDOM_RAY_COMPAT;
        this.cache.set(pythonCommand, compat);
        console.log(`[OpenMC Compat Probe] ${pythonCommand}: ray_source=${compat.raySourceFormat}, adjoint_source=${compat.adjointSource}`);
        return compat;
    }

    /**
     * Run the probe script against a python command.
     * @param pythonCommand - Python executable path
     * @returns Probe result, or undefined on any failure
     */
    protected runProbe(pythonCommand: string): RandomRayXmlCompat | undefined {
        try {
            const result = cp.spawnSync(pythonCommand, ['-c', RANDOM_RAY_PROBE_SCRIPT], {
                encoding: 'utf-8',
                timeout: PROBE_TIMEOUT_MS
            });
            if (result.error || result.status !== 0) {
                return undefined;
            }
            return this.parseProbeOutput(result.stdout);
        } catch {
            return undefined;
        }
    }

    /**
     * Parse the probe's `<direct|wrapper> <adjoint|no-adjoint>` output line.
     * @param stdout - Probe stdout
     * @returns Parsed compatibility, or undefined if malformed
     */
    protected parseProbeOutput(stdout: string): RandomRayXmlCompat | undefined {
        const line = stdout
            .trim()
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .pop();
        const [format, adjoint] = (line ?? '').split(/\s+/);
        if (format !== 'direct' && format !== 'wrapper') {
            return undefined;
        }
        return { raySourceFormat: format, adjointSource: adjoint === 'adjoint' };
    }
}
