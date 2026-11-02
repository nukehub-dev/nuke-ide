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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    isPathWithin,
    validateSandboxedScriptPaths,
    normalizeScriptSandboxStatus,
    normalizeSandboxedScriptResult,
    sanitizeSandboxText,
    scriptSandboxPlatformReason,
    NukeCadBackendServiceImpl,
    ServiceResultCapture
} from './nuke-cad-backend-service';
import type {
    GeometryBuildRequest,
    BuildDocumentRequest,
    BuildFeaturesPartialRequest,
    InspectImportSourceRequest,
    SandboxedScriptBuildRequest,
    SandboxedScriptBuildResult
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

describe('sandboxed script path policy', () => {
    let root: string;
    let workspace: string;
    let script: string;
    let output: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-cad-sandbox-paths-'));
        workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        script = path.join(workspace, 'model.py');
        fs.writeFileSync(script, 'model = None\n', 'utf-8');
        output = path.join(workspace, '.nuke-ide', 'ai', 'cad-scripts', 'job-1');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function request(overrides: Partial<SandboxedScriptBuildRequest> = {}): SandboxedScriptBuildRequest {
        return { scriptPath: script, workspaceRoot: workspace, outputDirectory: output, ...overrides };
    }

    it('detects containment without a prefix false positive', () => {
        expect(isPathWithin('/tmp/work', '/tmp/work/model.py')).toBe(true);
        expect(isPathWithin('/tmp/work', '/tmp/work')).toBe(true);
        expect(isPathWithin('/tmp/work', '/tmp/work-other/model.py')).toBe(false);
        expect(isPathWithin('/tmp/work', '/tmp/other/model.py')).toBe(false);
    });

    it('accepts a workspace script and creates the private output directory', () => {
        const result = validateSandboxedScriptPaths(request());

        expect('error' in result).toBe(false);
        if ('error' in result) {
            return;
        }
        expect(result.scriptPath).toBe(fs.realpathSync(script));
        expect(result.outputDirectory).toBe(fs.realpathSync(output));
        expect(fs.statSync(output).isDirectory()).toBe(true);
    });

    it('rejects relative paths', () => {
        expect(validateSandboxedScriptPaths(request({ scriptPath: 'model.py' }))).toEqual({
            error: 'scriptPath must be an absolute path.'
        });
    });

    it('rejects scripts outside the workspace', () => {
        const outside = path.join(root, 'outside.py');
        fs.writeFileSync(outside, 'model = None\n', 'utf-8');
        expect(validateSandboxedScriptPaths(request({ scriptPath: outside }))).toEqual({
            error: 'scriptPath must be inside workspaceRoot.'
        });
    });

    it('rejects symbolic link scripts', () => {
        const link = path.join(workspace, 'model-link.py');
        fs.symlinkSync(script, link);
        expect(validateSandboxedScriptPaths(request({ scriptPath: link }))).toEqual({
            error: 'scriptPath must not be a symbolic link.'
        });
    });

    it('rejects non-python and non-regular scripts', () => {
        const text = path.join(workspace, 'model.txt');
        fs.writeFileSync(text, 'model = None\n', 'utf-8');
        expect(validateSandboxedScriptPaths(request({ scriptPath: text }))).toEqual({
            error: 'scriptPath must point to a .py file.'
        });

        const directory = path.join(workspace, 'directory.py');
        fs.mkdirSync(directory);
        expect(validateSandboxedScriptPaths(request({ scriptPath: directory }))).toEqual({
            error: 'scriptPath must be a regular file.'
        });
    });

    it('rejects output outside the cad-scripts staging root', () => {
        expect(validateSandboxedScriptPaths(request({ outputDirectory: path.join(workspace, 'output') }))).toEqual({
            error: 'outputDirectory must be inside <workspace>/.nuke-ide/ai/cad-scripts/.'
        });
    });

    it('rejects symbolic link output directories', () => {
        const real = path.join(workspace, '.nuke-ide', 'ai', 'cad-scripts-real');
        fs.mkdirSync(real, { recursive: true });
        const link = path.join(workspace, '.nuke-ide', 'ai', 'cad-scripts');
        fs.symlinkSync(real, link);
        expect(validateSandboxedScriptPaths(request())).toEqual({
            error: 'The workspace sandbox staging directory must not be a symbolic link.'
        });
    });
});

describe('sandbox result normalization', () => {
    const output = '/tmp/nuke-cad-sandbox-output';

    it('normalizes a successful result and keeps only bounded fields', () => {
        const raw = {
            success: true,
            stepPath: path.join(output, 'model.step'),
            tessPath: path.join(output, 'model.tess.json'),
            solidCount: 1,
            faceCount: 6,
            triangleCount: 12,
            boundingBox: { min: [0, 0, 0], max: [1, 2, 3] },
            durationMs: 42,
            timedOut: false,
            exitCode: 0,
            output: 'host stderr',
            jobId: 'job-1',
            sandbox: {
                available: true,
                engine: 'bubblewrap',
                version: 'bubblewrap 0.13.1',
                seccomp: true,
                seccompVersion: '2.6.0',
                network: 'none',
                workspace: 'none',
                writable: ['/out', '/tmp', '/dev/shm'],
                limits: { timeoutSeconds: 120, memoryLimitMb: 4096, processLimit: 128, fileSizeLimitMb: 512, nofile: 256, core: 0 }
            }
        };
        const result = normalizeSandboxedScriptResult(raw, output);

        expect(result.success).toBe(true);
        expect(result.stepPath).toBe(path.join(output, 'model.step'));
        expect(result.tessPath).toBe(path.join(output, 'model.tess.json'));
        expect(result.solidCount).toBe(1);
        expect(result.triangleCount).toBe(12);
        expect(result.boundingBox).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
        expect((result as unknown as Record<string, unknown>).output).toBeUndefined();
        expect((result as unknown as Record<string, unknown>).jobId).toBeUndefined();
        expect(result.sandbox?.network).toBe('none');
        expect(result.sandbox?.workspace).toBe('none');
        expect(result.sandbox?.seccomp).toBe(true);
        expect(result.sandbox?.seccompVersion).toBe('2.6.0');
        expect(result.sandbox?.limits.nofile).toBe(256);
    });

    it('rejects artifacts outside the output directory', () => {
        const result = normalizeSandboxedScriptResult(
            {
                success: true,
                stepPath: '/tmp/elsewhere/model.step',
                tessPath: path.join(output, 'model.tess.json')
            },
            output
        );
        expect(result).toEqual({
            success: false,
            error: 'Sandboxed build returned an artifact outside its output directory.'
        });
    });

    it('rejects successful results without both artifacts', () => {
        expect(normalizeSandboxedScriptResult({ success: true, stepPath: path.join(output, 'model.step') }, output)).toEqual({
            success: false,
            error: 'Sandboxed build returned an artifact outside its output directory.'
        });
    });

    it('sanitizes failure messages and preserves warnings', () => {
        const result = normalizeSandboxedScriptResult(
            {
                success: false,
                error: `Script failed under ${output}`,
                warnings: [`stderr from ${output}`],
                sandbox: { available: true, engine: 'bubblewrap', network: 'none', workspace: 'none', writable: [] }
            },
            output
        );
        expect(result.success).toBe(false);
        expect(result.error).not.toContain(output);
        expect(result.error).toContain('<path>');
        expect(result.warnings?.[0]).not.toContain(output);
        expect(result.sandbox?.writable).toEqual([]);
    });

    it('rejects non-object responses', () => {
        expect(normalizeSandboxedScriptResult('not json', output)).toEqual({
            success: false,
            error: 'Sandboxed build returned an invalid response.'
        });
    });

    it('normalizes probe status and unavailable reasons', () => {
        expect(
            normalizeScriptSandboxStatus({
                available: true,
                engine: 'bubblewrap',
                userns: true,
                disableUserns: true,
                seccomp: true,
                seccompVersion: '2.6.0'
            })
        ).toEqual({
            available: true,
            engine: 'bubblewrap',
            userns: true,
            disableUserns: true,
            seccomp: true,
            seccompVersion: '2.6.0'
        });
        expect(normalizeScriptSandboxStatus({ available: false, reason: 'bwrap missing' })).toEqual({
            available: false,
            engine: 'bubblewrap',
            reason: 'bwrap missing'
        });
        expect(normalizeScriptSandboxStatus({ success: false, error: 'probe failed' })).toEqual({
            available: false,
            engine: 'bubblewrap',
            reason: 'probe failed'
        });
    });

    it('strips host paths from messages', () => {
        const sanitized = sanitizeSandboxText(`failed at ${output}/model.step and /home/user/.cache`, [output]);
        expect(sanitized).not.toContain(output);
        expect(sanitized).not.toContain('/home/user');
        expect(sanitized).toContain('<path>');
    });
});

describe('sandbox platform support', () => {
    it('fails closed on macOS and Windows without probing Python or libseccomp', () => {
        for (const platform of ['darwin', 'win32']) {
            const reason = scriptSandboxPlatformReason(platform);
            expect(reason).toContain('Linux');
            expect(reason).toContain('macOS and Windows');
        }
        expect(scriptSandboxPlatformReason('linux')).toBeUndefined();
    });
});

describe('sandbox backend service', () => {
    let root: string;
    let workspace: string;
    let script: string;
    let output: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-cad-sandbox-service-'));
        workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        script = path.join(workspace, 'model.py');
        fs.writeFileSync(script, 'model = None\n', 'utf-8');
        output = path.join(workspace, '.nuke-ide', 'ai', 'cad-scripts', 'job-1');
        fs.mkdirSync(output, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function request(overrides: Partial<SandboxedScriptBuildRequest> = {}): SandboxedScriptBuildRequest {
        return { scriptPath: script, workspaceRoot: workspace, outputDirectory: output, ...overrides };
    }

    function fakeService(): { service: NukeCadBackendServiceImpl; calls: any[] } {
        const service = new NukeCadBackendServiceImpl();
        const calls: any[] = [];
        (service as any).nukeCoreService = { getPythonCommand: async () => '/usr/bin/python3' };
        return { service, calls };
    }

    it('spawns the sandbox service with a private request file and job id', async () => {
        const { service, calls } = fakeService();
        let capturedRequest: Record<string, unknown> | undefined;
        let requestPath: string | undefined;
        (service as any)._spawnJsonService = async (
            python: string,
            args: string[],
            cwd: string,
            scriptPath: string | undefined,
            options: { jobId?: string; timeoutSeconds?: number }
        ) => {
            requestPath = args[args.indexOf('--request') + 1];
            capturedRequest = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
            calls.push({ python, args, cwd, scriptPath, options });
            return {
                success: true,
                stepPath: path.join(output, 'model.step'),
                tessPath: path.join(output, 'model.tess.json'),
                solidCount: 1,
                triangleCount: 12
            } as SandboxedScriptBuildResult;
        };

        const result = await service.buildSandboxedScript(request({ jobId: 'job-42', timeoutSeconds: 120 }));

        expect(result.success).toBe(true);
        expect(calls).toHaveLength(1);
        expect(path.basename(calls[0].args[0])).toBe('sandbox_service.py');
        expect(calls[0].args).toContain('--request');
        expect(calls[0].cwd).toBe(fs.realpathSync(output));
        expect(calls[0].options).toEqual({ jobId: 'job-42', timeoutSeconds: 130 });
        expect(capturedRequest?.scriptPath).toBe(fs.realpathSync(script));
        expect(capturedRequest?.workspaceRoot).toBe(fs.realpathSync(workspace));
        expect(requestPath).toBeDefined();
        expect(fs.existsSync(requestPath!)).toBe(false);
    });

    it('returns validation failures without spawning', async () => {
        const { service, calls } = fakeService();
        (service as any)._spawnJsonService = async () => {
            calls.push(true);
            return { success: true } as SandboxedScriptBuildResult;
        };

        const result = await service.buildSandboxedScript(request({ outputDirectory: path.join(workspace, 'outside') }));

        expect(result.success).toBe(false);
        expect(result.error).toContain('cad-scripts');
        expect(calls).toHaveLength(0);
    });

    it('rejects artifact paths outside the validated output directory', async () => {
        const { service } = fakeService();
        (service as any)._spawnJsonService = async () => ({
            success: true,
            stepPath: '/tmp/outside/model.step',
            tessPath: path.join(output, 'model.tess.json')
        });

        const result = await service.buildSandboxedScript(request());

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside its output directory');
    });

    it('returns unavailable status when the probe fails', async () => {
        const { service } = fakeService();
        (service as any)._spawnJsonService = async () => ({ success: false, error: 'spawn failed' });

        const status = await service.getScriptSandboxStatus();

        expect(status.available).toBe(false);
        expect(status.engine).toBe('bubblewrap');
        expect(status.reason).toContain('spawn failed');
    });

    it('reports an available probe result', async () => {
        const { service } = fakeService();
        (service as any)._spawnJsonService = async () => ({
            available: true,
            engine: 'bubblewrap',
            bwrapPath: '/usr/bin/bwrap',
            version: 'bubblewrap 0.13.1',
            userns: true,
            disableUserns: true,
            seccomp: true,
            seccompVersion: '2.6.0'
        });

        const status = await service.getScriptSandboxStatus();

        expect(status).toEqual({
            available: true,
            engine: 'bubblewrap',
            bwrapPath: '/usr/bin/bwrap',
            version: 'bubblewrap 0.13.1',
            userns: true,
            disableUserns: true,
            seccomp: true,
            seccompVersion: '2.6.0'
        });
    });

    it('runs the real probe through the Python service', async () => {
        const service = new NukeCadBackendServiceImpl();
        (service as any).nukeCoreService = { getPythonCommand: async () => '/usr/bin/python3' };

        const status = await service.getScriptSandboxStatus();

        expect(status.engine).toBe('bubblewrap');
        if (status.available) {
            expect(status.version).toContain('bubblewrap');
            expect(status.seccomp).toBe(true);
            expect(status.seccompVersion).toMatch(/^\d+\.\d+\.\d+$/);
        } else {
            expect(typeof status.reason).toBe('string');
        }
    });

    it.skipIf(process.platform === 'win32')('escalates cancellation from SIGTERM to SIGKILL', () => {
        vi.useFakeTimers();
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        try {
            const service = new NukeCadBackendServiceImpl();
            const child = { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn() } as any;
            (service as any).killJob({ jobId: 'job-1', process: child, cancelled: false, timedOut: false });

            expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
            vi.advanceTimersByTime(1000);
            expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
        } finally {
            killSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it.skipIf(process.platform === 'win32')('does not SIGKILL a process that already exited', () => {
        vi.useFakeTimers();
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        try {
            const service = new NukeCadBackendServiceImpl();
            const child = { pid: 4243, exitCode: 0, signalCode: null, kill: vi.fn() } as any;
            (service as any).killJob({ jobId: 'job-1', process: child, cancelled: false, timedOut: false });

            vi.advanceTimersByTime(1000);
            expect(killSpy).toHaveBeenCalledTimes(1);
            expect(killSpy).toHaveBeenCalledWith(-4243, 'SIGTERM');
        } finally {
            killSpy.mockRestore();
            vi.useRealTimers();
        }
    });
});
