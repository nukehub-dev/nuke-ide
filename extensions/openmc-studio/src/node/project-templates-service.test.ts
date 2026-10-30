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
 * Backend template RPC contract: the picker gets real default states and
 * `applyTemplate` returns the same built state as the shared builder.
 */

import { describe, it, expect } from 'vitest';
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';

describe('project template backend', () => {
    it('lists templates with built default states', async () => {
        const backend = new OpenMCStudioBackendServiceImpl();
        const response = await backend.getTemplates();
        expect(response.templates).toHaveLength(6);
        const pin = response.templates.find((template) => template.id === 'pin-cell');
        expect(pin?.defaultState.materials).toHaveLength(3);
        expect(pin?.defaultState.geometry?.cells).toHaveLength(4);
        expect(pin?.whatYouGet?.length).toBeGreaterThan(0);
        expect(pin?.parameters?.some((parameter) => parameter.key === 'enrichmentPct')).toBe(true);
    });

    it('applies parameters and the project name', async () => {
        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.applyTemplate({
            templateId: 'pin-cell',
            parameters: { enrichmentPct: 3.2, projectName: 'My Pin Cell' }
        });
        expect(result.success, result.error).toBe(true);
        expect(result.state?.metadata.name).toBe('My Pin Cell');
        const fuel = result.state?.materials.find((material) => material.id === 1);
        expect(fuel?.nuclides.find((nuclide) => nuclide.name === 'U235')?.fraction).toBeCloseTo(3.2, 6);
    });

    it('rejects unknown template ids instead of silently creating a blank project', async () => {
        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.applyTemplate({ templateId: 'does-not-exist' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown project template');
    });
});
