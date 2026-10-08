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

import { describe, expect, it } from 'vitest';
import { OpenMCOutputService } from './openmc-output-service';

function serviceWithStdout(stdout: string, status = 0): OpenMCOutputService {
    // Bypass DI: runConversion only touches pythonHelper.
    const service = Object.create(OpenMCOutputService.prototype) as OpenMCOutputService;
    (service as unknown as { pythonHelper: unknown }).pythonHelper = {
        findScript: () => 'server.py',
        executeScript: async () => ({ status, stdout, stderr: '' })
    };
    return service;
}

describe('runConversion arrayName', () => {
    it('hoists arrayName out of stats onto the result', async () => {
        const service = serviceWithStdout(JSON.stringify({ vtkPath: '/tmp/x.vtm', arrayName: 'flux-mean', nVolumes: 22 }));
        const result = await service.convertOverlayGeometryToVtk('/tmp/sp.h5', '/tmp/g.h5m', { tallyId: 4 });
        expect(result.success).toBe(true);
        expect(result.vtkPath).toBe('/tmp/x.vtm');
        expect(result.arrayName).toBe('flux-mean');
        expect(result.stats).toEqual({ nVolumes: 22 });
    });

    it('leaves arrayName undefined when the command omits it', async () => {
        const service = serviceWithStdout(JSON.stringify({ vtkPath: '/tmp/x.vtp', nPoints: 8 }));
        const result = await service.convertOverlayToVtk('/tmp/sp.h5', { tallyId: 1 });
        expect(result.success).toBe(true);
        expect(result.arrayName).toBeUndefined();
        expect(result.stats).toEqual({ nPoints: 8 });
    });
});
