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
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import {
    buildGeometryArgs,
    buildDocumentArgs,
    buildFeaturesPartialArgs,
    inspectImportArgs,
    normalizeInspectImportResult,
    isAllowedDownloadUrl,
    NukeCadBackendServiceImpl,
    ServiceResultCapture
} from './nuke-cad-backend-service';
import type {
    GeometryBuildRequest,
    BuildDocumentRequest,
    BuildFeaturesPartialRequest,
    InspectImportSourceRequest
} from '../common/nuke-cad-protocol';

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
            '--cache-dir',
            '/tmp',
            '--tolerance',
            '0.005',
            '--no-dagmc',
            '--no-mesh'
        ]);
    });

    it('always primes the cache in the document directory by default', () => {
        const request: BuildDocumentRequest = { scriptPath: '/work/models/model.nuke-cad' };
        const args = buildDocumentArgs(request, SCRIPT_PATH);
        expect(args[args.indexOf('--cache-dir') + 1]).toBe('/work/models');
    });

    it('honours an explicit cacheDir', () => {
        const request: BuildDocumentRequest = { scriptPath: MODEL_PATH, cacheDir: '/work/cache' };
        const args = buildDocumentArgs(request, SCRIPT_PATH);
        expect(args[args.indexOf('--cache-dir') + 1]).toBe('/work/cache');
    });

    it('omits --cache-dir for export builds', () => {
        for (const exports of [{ exportDagmc: true }, { exportMesh: true }, { exportDagmc: true, exportMesh: true }]) {
            const request: BuildDocumentRequest = { scriptPath: MODEL_PATH, ...exports };
            const args = buildDocumentArgs(request, SCRIPT_PATH);
            expect(args).not.toContain('--cache-dir');
        }
    });

    it('omits --cache-dir for transient preview documents', () => {
        const request: BuildDocumentRequest = { scriptPath: '/tmp/preview.nuke-cad', useCache: false };
        const args = buildDocumentArgs(request, SCRIPT_PATH);
        expect(args).not.toContain('--cache-dir');
    });
});

describe('buildFeaturesPartialArgs', () => {
    it('passes the partial RPC shape as CLI flags', () => {
        const request: BuildFeaturesPartialRequest = { scriptPath: MODEL_PATH, featureIds: ['f1', 'f2'], cacheDir: '/tmp/out' };
        expect(buildFeaturesPartialArgs(request, SCRIPT_PATH)).toEqual([
            SCRIPT_PATH,
            MODEL_PATH,
            '--from-document',
            '--partial-feature-ids',
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
        expect(args).toContain('--partial-feature-ids');
        expect(args).not.toContain('--cache-dir');
    });

    it('passes --size-cap-mb when the caller threads the size preference', () => {
        const request: BuildFeaturesPartialRequest = {
            scriptPath: MODEL_PATH,
            featureIds: ['f1', 'f2'],
            cacheDir: '/tmp/out',
            sizeCapMB: 1024
        };
        expect(buildFeaturesPartialArgs(request, SCRIPT_PATH)).toEqual([
            SCRIPT_PATH,
            MODEL_PATH,
            '--from-document',
            '--partial-feature-ids',
            'f1,f2',
            '--no-dagmc',
            '--no-mesh',
            '--cache-dir',
            '/tmp/out',
            '--size-cap-mb',
            '1024'
        ]);
    });

    it('omits --size-cap-mb when the caller leaves the cap to the backend default', () => {
        const request: BuildFeaturesPartialRequest = { scriptPath: MODEL_PATH, featureIds: ['f1'] };
        const args = buildFeaturesPartialArgs(request, SCRIPT_PATH);
        expect(args).not.toContain('--size-cap-mb');
    });

    it('passes a single id without separators', () => {
        const request: BuildFeaturesPartialRequest = { scriptPath: MODEL_PATH, featureIds: ['only'] };
        const args = buildFeaturesPartialArgs(request, SCRIPT_PATH);
        expect(args[args.indexOf('--partial-feature-ids') + 1]).toBe('only');
    });

    it('passes the resolved display tolerance', () => {
        const request: BuildFeaturesPartialRequest = { scriptPath: MODEL_PATH, featureIds: ['f1'], tolerance: 0.01 };
        const args = buildFeaturesPartialArgs(request, SCRIPT_PATH);
        expect(args[args.indexOf('--tolerance') + 1]).toBe('0.01');
    });
});

describe('buildFeaturesPartialArgs CLI parity with geometry_service.py', () => {
    it('only emits flags that the Python parser declares', () => {
        const request: BuildFeaturesPartialRequest = {
            scriptPath: MODEL_PATH,
            featureIds: ['f1', 'f2'],
            cacheDir: '/tmp/out',
            tolerance: 0.01,
            sizeCapMB: 1024
        };
        const args = buildFeaturesPartialArgs(request, SCRIPT_PATH);
        const emittedFlags = args.filter((arg) => arg.startsWith('--'));
        expect(emittedFlags).toContain('--partial-feature-ids');

        const serviceSource = fs.readFileSync(path.join(__dirname, '../../python/geometry_service.py'), 'utf-8');
        const declaredFlags = new Set(
            Array.from(serviceSource.matchAll(/add_argument\(\s*["']([^"']+)["']/g), (match) => match[1]).filter((flag) =>
                flag.startsWith('--')
            )
        );
        for (const flag of emittedFlags) {
            expect(declaredFlags.has(flag), `${flag} is not declared in geometry_service.py`).toBe(true);
        }
    });
});

describe('inspectImportArgs', () => {
    it('passes the source positionally with --inspect-import and no optional flags', () => {
        const request: InspectImportSourceRequest = { sourcePath: STEP_PATH };
        expect(inspectImportArgs(request, SCRIPT_PATH)).toEqual([SCRIPT_PATH, STEP_PATH, '--inspect-import']);
    });

    it('passes the unit overrides and solid cap when provided', () => {
        const request: InspectImportSourceRequest = {
            sourcePath: STEP_PATH,
            sourceUnit: 'm',
            targetUnits: 'mm',
            maxSolids: 50
        };
        expect(inspectImportArgs(request, SCRIPT_PATH)).toEqual([
            SCRIPT_PATH,
            STEP_PATH,
            '--inspect-import',
            '--source-unit',
            'm',
            '--target-units',
            'mm',
            '--max-solids',
            '50'
        ]);
    });

    it('keeps only the source-unit override', () => {
        const request: InspectImportSourceRequest = { sourcePath: STEP_PATH, sourceUnit: 'cm' };
        expect(inspectImportArgs(request, SCRIPT_PATH)).toEqual([SCRIPT_PATH, STEP_PATH, '--inspect-import', '--source-unit', 'cm']);
    });

    it('never emits build/artifact flags', () => {
        const args = inspectImportArgs({ sourcePath: STEP_PATH, maxSolids: 5 }, SCRIPT_PATH);
        for (const flag of [
            '--output-dir',
            '--from-step',
            '--from-document',
            '--from-drawing',
            '--cache-dir',
            '--dagmc',
            '--no-dagmc',
            '--mesh',
            '--no-mesh'
        ]) {
            expect(args).not.toContain(flag);
        }
    });
});

describe('normalizeInspectImportResult', () => {
    const HASH = 'a'.repeat(64);

    const canonical = {
        success: true,
        sourcePath: STEP_PATH,
        sourceFormat: 'step' as const,
        sourceHash: HASH,
        sourceSize: 1234,
        fileUnit: 'mm',
        effectiveUnit: 'm',
        unitScaleFactor: 0.001,
        unitsMessage: 'Unit override: m',
        solidCount: 1,
        solids: [
            {
                index: 1,
                name: 'coil',
                faceCount: 12,
                volume: 3.5,
                bboxMin: [0, 0, 0],
                bboxMax: [1, 2, 3],
                center: [0.5, 1, 1.5]
            }
        ],
        warnings: ['one warning']
    };

    it('passes a canonical camelCase payload through', () => {
        expect(normalizeInspectImportResult(canonical, STEP_PATH)).toEqual(canonical);
    });

    it('maps the exchange-reader snake_case payload to the RPC shape', () => {
        const raw = {
            success: true,
            source_path: STEP_PATH,
            source_format: 'STEP',
            digest: HASH,
            size: 99,
            file_unit: 'mm',
            effective_unit: 'mm',
            unit_scale: 1,
            units_message: 'Detected mm',
            solid_count: 2,
            solids: [
                {
                    index: 1,
                    name: 'body-a',
                    face_count: 6,
                    volume: 1,
                    bbox_min: [0, 0, 0],
                    bbox_max: [1, 1, 1],
                    center: [0.5, 0.5, 0.5]
                },
                { index: 2, face_count: 8, volume: 2, bbox_min: [1, 0, 0], bbox_max: [2, 1, 1], center: [1.5, 0.5, 0.5] }
            ],
            warnings: ['w']
        };
        expect(normalizeInspectImportResult(raw, STEP_PATH)).toEqual({
            success: true,
            sourcePath: STEP_PATH,
            sourceFormat: 'step',
            sourceHash: HASH,
            sourceSize: 99,
            fileUnit: 'mm',
            effectiveUnit: 'mm',
            unitScaleFactor: 1,
            unitsMessage: 'Detected mm',
            solidCount: 2,
            solids: [
                {
                    index: 1,
                    name: 'body-a',
                    faceCount: 6,
                    volume: 1,
                    bboxMin: [0, 0, 0],
                    bboxMax: [1, 1, 1],
                    center: [0.5, 0.5, 0.5]
                },
                { index: 2, faceCount: 8, volume: 2, bboxMin: [1, 0, 0], bboxMax: [2, 1, 1], center: [1.5, 0.5, 0.5] }
            ],
            warnings: ['w']
        });
    });

    it('falls back to the requested source path and derives the solid count', () => {
        const result = normalizeInspectImportResult(
            {
                solids: [
                    { face_count: 6, volume: 1 },
                    { face_count: 8, volume: 2 }
                ]
            },
            STEP_PATH
        );
        expect(result.success).toBe(true);
        expect(result.sourcePath).toBe(STEP_PATH);
        expect(result.solidCount).toBe(2);
        expect(result.solids?.map((solid) => solid.index)).toEqual([1, 2]);
    });

    it('preserves Python failures and their error message', () => {
        expect(normalizeInspectImportResult({ success: false, error: 'Too many solids (700 > 500).' }, STEP_PATH)).toEqual({
            success: false,
            error: 'Too many solids (700 > 500).',
            sourcePath: STEP_PATH
        });
    });

    it('treats an error payload without a success flag as a failure', () => {
        const result = normalizeInspectImportResult({ error: 'Unsupported format.' }, STEP_PATH);
        expect(result.success).toBe(false);
        expect(result.error).toBe('Unsupported format.');
        expect(result.solids).toBeUndefined();
    });

    it('rejects a non-object payload', () => {
        const result = normalizeInspectImportResult('not json', STEP_PATH);
        expect(result.success).toBe(false);
        expect(result.sourcePath).toBe(STEP_PATH);
        expect(result.error).toContain('invalid response');
    });

    it('drops malformed solid entries and ignores unknown formats', () => {
        const result = normalizeInspectImportResult(
            { success: true, source_format: 'gltf', solids: ['nope', { index: 3, face_count: 4, volume: 2 }] },
            STEP_PATH
        );
        expect(result.sourceFormat).toBeUndefined();
        expect(result.solidCount).toBe(1);
        expect(result.solids).toEqual([{ index: 3, faceCount: 4, volume: 2, bboxMin: [], bboxMax: [], center: [] }]);
    });
});

describe('backend sample download', () => {
    it('allows HTTPS and loopback HTTP only', () => {
        expect(isAllowedDownloadUrl(new URL('https://example.com/model.step'))).toBe(true);
        expect(isAllowedDownloadUrl(new URL('http://127.0.0.1:8080/model.step'))).toBe(true);
        expect(isAllowedDownloadUrl(new URL('http://localhost/model.step'))).toBe(true);
        expect(isAllowedDownloadUrl(new URL('http://example.com/model.step'))).toBe(false);
        expect(isAllowedDownloadUrl(new URL('ftp://example.com/model.step'))).toBe(false);
    });

    it('downloads through the backend, follows redirects, and creates parent folders', async () => {
        const payload = Buffer.from('ISO-10303-21;\nbackend download test\n');
        const server = http.createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(302, { Location: '/model.step' });
                response.end();
                return;
            }
            response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
            response.end(payload);
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address() as AddressInfo;
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nuke-cad-download-'));
        const target = path.join(directory, 'nested', 'model.step');
        try {
            const result = await new NukeCadBackendServiceImpl().downloadFile({
                url: `http://127.0.0.1:${address.port}/redirect`,
                targetPath: target
            });
            expect(result).toEqual({ success: true, path: target, bytes: payload.length });
            expect(await fs.promises.readFile(target)).toEqual(payload);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    });

    it('reports an HTTP failure without creating the target', async () => {
        const server = http.createServer((_request, response) => {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('not found');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address() as AddressInfo;
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nuke-cad-download-fail-'));
        const target = path.join(directory, 'model.step');
        try {
            const result = await new NukeCadBackendServiceImpl().downloadFile({
                url: `http://127.0.0.1:${address.port}/missing.step`,
                targetPath: target
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('HTTP 404');
            expect(fs.existsSync(target)).toBe(false);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    });
});

describe('ServiceResultCapture', () => {
    it('parses a result line larger than the bounded stdout tail', async () => {
        const service = new NukeCadBackendServiceImpl();
        const script = "process.stdout.write('__NUKE_RESULT__' + JSON.stringify({success:true,dxf:'0\\nEOF\\n'.repeat(200000)}) + '\\n');";
        const result = await (service as any)._spawnJsonService(process.execPath, ['-e', script], process.cwd());
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.dxf.length).toBeGreaterThan(1024 * 1024);
    });

    it('keeps a result line larger than the bounded diagnostic tail', () => {
        const capture = new ServiceResultCapture();
        const payload = JSON.stringify({
            success: true,
            svg: '<svg/>',
            dxf: '0\nEOF\n'.repeat(300_000)
        });
        const line = `__NUKE_RESULT__${payload}`;
        for (let offset = 0; offset < line.length; offset += 64 * 1024) {
            capture.append(line.slice(offset, offset + 64 * 1024));
        }
        capture.finish();
        expect(capture.resultLine).toBe(line);
        expect(capture.output.length).toBeLessThanOrEqual(1024 * 1024);
        expect(JSON.parse(capture.resultLine!.slice('__NUKE_RESULT__'.length))).toMatchObject({
            success: true,
            svg: '<svg/>'
        });
    });

    it('keeps the last marker line and flushes a newline-less tail', () => {
        const capture = new ServiceResultCapture();
        capture.append('progress line\n__NUKE_RESULT__{"success":false,"error":"old"}\n');
        capture.append('__NUKE_RESULT__{"success":true,"dxf":"EOF"}');
        capture.finish();
        expect(capture.resultLine).toBe('__NUKE_RESULT__{"success":true,"dxf":"EOF"}');
    });

    it('returns no result line for diagnostics-only output', () => {
        const capture = new ServiceResultCapture();
        capture.append('loading\ndone\n');
        capture.finish();
        expect(capture.resultLine).toBeUndefined();
        expect(capture.output).toContain('done');
    });
});
