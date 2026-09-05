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
import { buildGeometryArgs, buildDocumentArgs, buildFeaturesPartialArgs } from './nuke-cad-backend-service';
import type { GeometryBuildRequest, BuildDocumentRequest, BuildFeaturesPartialRequest } from '../common/nuke-cad-protocol';

const SCRIPT_PATH = '/tmp/geometry_service.py';
const MODEL_PATH = '/tmp/model.nuke-cad';
const STEP_PATH = '/tmp/model.step';
const PY_PATH = '/tmp/model.py';

describe('buildGeometryArgs', () => {
    it('passes --no-dagmc and --no-mesh for explicit false flags', () => {
        const request: GeometryBuildRequest = { scriptPath: PY_PATH, exportDagmc: false, exportMesh: false };
        const args = buildGeometryArgs(request, SCRIPT_PATH);
        expect(args).toContain('--no-dagmc');
        expect(args).toContain('--no-mesh');
    });

    it('skips export flags for script builds by default', () => {
        const request: GeometryBuildRequest = { scriptPath: PY_PATH };
        const args = buildGeometryArgs(request, SCRIPT_PATH);
        expect(args).not.toContain('--no-dagmc');
        expect(args).not.toContain('--no-mesh');
    });

    it('forces --no-dagmc and --no-mesh for STEP imports by default', () => {
        const request: GeometryBuildRequest = { scriptPath: STEP_PATH };
        const args = buildGeometryArgs(request, SCRIPT_PATH);
        expect(args).toContain('--from-step');
        expect(args).toContain('--no-dagmc');
        expect(args).toContain('--no-mesh');
    });

    it('keeps --no-dagmc when sourceType is step even for .nuke-cad extension', () => {
        const request: GeometryBuildRequest = { scriptPath: MODEL_PATH, sourceType: 'step' };
        const args = buildGeometryArgs(request, SCRIPT_PATH);
        expect(args).toContain('--from-step');
        expect(args).toContain('--no-dagmc');
        expect(args).toContain('--no-mesh');
    });

    it('allows explicit DAGMC/mesh export for STEP imports', () => {
        const request: GeometryBuildRequest = { scriptPath: STEP_PATH, exportDagmc: true, exportMesh: true };
        const args = buildGeometryArgs(request, SCRIPT_PATH);
        expect(args).not.toContain('--no-dagmc');
        expect(args).not.toContain('--no-mesh');
    });

    it('passes tolerance and mesh options when provided', () => {
        const request: GeometryBuildRequest = {
            scriptPath: PY_PATH,
            tolerance: 0.005,
            meshEngine: 'netgen',
            meshSize: 2,
            meshMinSize: 0.1,
            meshMaxSize: 5,
            meshOrder: 2,
            lengthScale: 0.01
        };
        const args = buildGeometryArgs(request, SCRIPT_PATH);
        expect(args).toEqual([
            SCRIPT_PATH,
            PY_PATH,
            '--tolerance',
            '0.005',
            '--mesh-engine',
            'netgen',
            '--mesh-size',
            '2',
            '--mesh-min-size',
            '0.1',
            '--mesh-max-size',
            '5',
            '--mesh-order',
            '2',
            '--length-scale',
            '0.01'
        ]);
    });
});

describe('buildDocumentArgs', () => {
    it('skips DAGMC and mesh export by default', () => {
        const request: BuildDocumentRequest = { scriptPath: MODEL_PATH };
        const args = buildDocumentArgs(request, SCRIPT_PATH);
        expect(args).toContain('--from-document');
        expect(args).toContain('--no-dagmc');
        expect(args).toContain('--no-mesh');
    });

    it('still skips exports when flags are explicitly false', () => {
        const request: BuildDocumentRequest = { scriptPath: MODEL_PATH, exportDagmc: false, exportMesh: false };
        const args = buildDocumentArgs(request, SCRIPT_PATH);
        expect(args).toContain('--no-dagmc');
        expect(args).toContain('--no-mesh');
    });

    it('allows explicit DAGMC and mesh export', () => {
        const request: BuildDocumentRequest = { scriptPath: MODEL_PATH, exportDagmc: true, exportMesh: true };
        const args = buildDocumentArgs(request, SCRIPT_PATH);
        expect(args).not.toContain('--no-dagmc');
        expect(args).not.toContain('--no-mesh');
    });

    it('passes tolerance and mesh options when provided', () => {
        const request: BuildDocumentRequest = {
            scriptPath: MODEL_PATH,
            tolerance: 0.005,
            outputDirectory: '/tmp/out'
        };
        const args = buildDocumentArgs(request, SCRIPT_PATH);
        expect(args).toEqual([
            SCRIPT_PATH,
            MODEL_PATH,
            '--from-document',
            '--output-dir',
            '/tmp/out',
            '--tolerance',
            '0.005',
            '--no-dagmc',
            '--no-mesh'
        ]);
    });
});

describe('buildFeaturesPartialArgs', () => {
    it('passes the partial RPC shape as CLI flags', () => {
        const request: BuildFeaturesPartialRequest = { scriptPath: MODEL_PATH, featureIds: ['f1', 'f2'], cacheDir: '/tmp/out' };
        expect(buildFeaturesPartialArgs(request, SCRIPT_PATH)).toEqual([
            SCRIPT_PATH,
            MODEL_PATH,
            '--from-document',
            '--partial-features',
            'f1,f2',
            '--no-dagmc',
            '--no-mesh',
            '--cache-dir',
            '/tmp/out'
        ]);
    });

    it('omits --cache-dir when the caller leaves policy to the backend default', () => {
        const request: BuildFeaturesPartialRequest = { scriptPath: MODEL_PATH, featureIds: ['f1'] };
        const args = buildFeaturesPartialArgs(request, SCRIPT_PATH);
        expect(args).toContain('--partial-features');
        expect(args).not.toContain('--cache-dir');
    });

    it('passes a single id without separators', () => {
        const request: BuildFeaturesPartialRequest = { scriptPath: MODEL_PATH, featureIds: ['only'] };
        const args = buildFeaturesPartialArgs(request, SCRIPT_PATH);
        expect(args[args.indexOf('--partial-features') + 1]).toBe('only');
    });
});
