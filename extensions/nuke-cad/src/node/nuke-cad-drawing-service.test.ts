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
import { buildDrawingArgs } from './nuke-cad-backend-service';
import type { DrawingBuildRequest } from '../common/cad-drawing';

const SCRIPT_PATH = '/tmp/geometry_service.py';
const MODEL_PATH = '/tmp/model.nuke-cad';

describe('buildDrawingArgs', () => {
    it('dispatches through geometry_service --from-drawing with the sheet id', () => {
        const request: DrawingBuildRequest = { scriptPath: MODEL_PATH, sheetId: 'sheet-1' };
        expect(buildDrawingArgs(request, SCRIPT_PATH)).toEqual([SCRIPT_PATH, MODEL_PATH, '--from-drawing', '--sheet-id', 'sheet-1']);
    });

    it('passes the output directory when provided', () => {
        const request: DrawingBuildRequest = { scriptPath: MODEL_PATH, sheetId: 'sheet-2', outputDirectory: '/tmp/out' };
        expect(buildDrawingArgs(request, SCRIPT_PATH)).toEqual([
            SCRIPT_PATH,
            MODEL_PATH,
            '--from-drawing',
            '--sheet-id',
            'sheet-2',
            '--output-dir',
            '/tmp/out'
        ]);
    });
});
