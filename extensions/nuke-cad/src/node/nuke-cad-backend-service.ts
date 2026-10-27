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
 * Nuke CAD backend service.
 *
 * Spawns the Python geometry service in the active nuke-core Python environment
 * and parses its stdout-JSON result.
 *
 * @module nuke-cad/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { resolvePythonScript } from 'nuke-core/lib/node/utils/script-resolver';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import {
    NukeCadBackendService,
    GeometryBuildRequest,
    GeometryBuildResult,
    BuildDocumentRequest,
    BuildFeaturesPartialRequest,
    DownloadFileRequest,
    DownloadFileResult,
    FemRunRequest,
    FemRunResult,
    FemMaterial,
    JobRunRequest,
    JobRunResult,
    FoamCaseRequest,
    FoamCaseResult,
    FoamStlExportRequest,
    FoamStlExportResult,
    InspectImportSourceRequest,
    InspectImportSourceResult,
    ImportSolidInfo,
    ImportSourceFormat
} from '../common/nuke-cad-protocol';
import { CAD_HEALTH_PACKAGES } from '../common/packages';
import type { DrawingBuildRequest, DrawingBuildResult } from '../common/cad-drawing';

/**
 * Build the argument list for ``python/geometry_service.py`` from a script/STEP request.
 *
 * Exported for unit testing; callers should use {@link NukeCadBackendServiceImpl.buildGeometry}.
 */
export function buildGeometryArgs(request: GeometryBuildRequest, scriptPath: string): string[] {
    const ext = request.scriptPath.split('.').pop()?.toLowerCase();
    const sourceType = request.sourceType ?? (ext === 'step' || ext === 'stp' || ext === 'brep' ? 'step' : 'script');
    const args = [scriptPath, request.scriptPath];
    if (sourceType === 'step') {
        args.push('--from-step');
    }
    if (request.outputDirectory) {
        args.push('--output-dir', request.outputDirectory);
    }
    if (request.tolerance !== undefined) {
        args.push('--tolerance', String(request.tolerance));
    }
    // STEP imports are interactive viewport loads where DAGMC/mesh export is
    // slow and off by default. Enforce the skip in the backend — not only at
    // the open call sites — so every code path (e.g. REBUILD_GEOMETRY, which
    // sends neither flag) is safe. Callers can still opt in with `true`.
    if (request.exportDagmc === false || (sourceType === 'step' && request.exportDagmc === undefined)) {
        args.push('--no-dagmc');
    }
    if (request.exportMesh === false || (sourceType === 'step' && request.exportMesh === undefined)) {
        args.push('--no-mesh');
    }
    if (request.meshEngine) {
        args.push('--mesh-engine', request.meshEngine);
    }
    if (request.meshSize !== undefined) {
        args.push('--mesh-size', String(request.meshSize));
    }
    if (request.meshMinSize !== undefined) {
        args.push('--mesh-min-size', String(request.meshMinSize));
    }
    if (request.meshMaxSize !== undefined) {
        args.push('--mesh-max-size', String(request.meshMaxSize));
    }
    if (request.meshOrder !== undefined) {
        args.push('--mesh-order', String(request.meshOrder));
    }
    if (request.lengthScale !== undefined) {
        args.push('--length-scale', String(request.lengthScale));
    }
    return args;
}

/**
 * Build the argument list for ``python/geometry_service.py --from-document``.
 *
 * Document opens and rebuilds are viewport-only operations, so DAGMC and FEM
 * mesh export are skipped when the caller does not explicitly request them.
 * Exported for unit testing; callers should use {@link NukeCadBackendServiceImpl.buildDocument}.
 */
export function buildDocumentArgs(request: BuildDocumentRequest, scriptPath: string): string[] {
    const args = [scriptPath, request.scriptPath, '--from-document'];
    if (request.outputDirectory) {
        args.push('--output-dir', request.outputDirectory);
    }
    // Full document builds must prime the per-feature cache so the next edit
    // can run partially; default to the document's directory like the partial
    // path does. Transient preview documents opt out (their temp directory
    // must not accumulate cache zips) and so do export builds (DAGMC/mesh),
    // where a sidecar write is pure overhead.
    const isDisplayBuild = request.exportDagmc !== true && request.exportMesh !== true;
    if (request.useCache !== false && isDisplayBuild) {
        args.push('--cache-dir', request.cacheDir ?? path.dirname(request.scriptPath));
    }
    if (request.tolerance !== undefined) {
        args.push('--tolerance', String(request.tolerance));
    }
    // Document builds default to viewport-only: skip expensive DAGMC/mesh
    // export unless the caller explicitly opts in with `true`.
    if (request.exportDagmc === false || request.exportDagmc === undefined) {
        args.push('--no-dagmc');
    }
    if (request.exportMesh === false || request.exportMesh === undefined) {
        args.push('--no-mesh');
    }
    if (request.meshEngine) {
        args.push('--mesh-engine', request.meshEngine);
    }
    if (request.meshSize !== undefined) {
        args.push('--mesh-size', String(request.meshSize));
    }
    if (request.meshMinSize !== undefined) {
        args.push('--mesh-min-size', String(request.meshMinSize));
    }
    if (request.meshMaxSize !== undefined) {
        args.push('--mesh-max-size', String(request.meshMaxSize));
    }
    if (request.meshOrder !== undefined) {
        args.push('--mesh-order', String(request.meshOrder));
    }
    if (request.lengthScale !== undefined) {
        args.push('--length-scale', String(request.lengthScale));
    }
    return args;
}

/**
 * Build the argument list for ``python/geometry_service.py --from-document``
 * partial rebuilds (P2 result cache).
 *
 * ``featureIds`` travel as a single comma-separated ``--partial-feature-ids``
 * argument; ``cacheDir`` travels as ``--cache-dir`` when supplied (otherwise
 * the backend defaults to the document file's directory) and ``sizeCapMB``
 * travels as ``--size-cap-mb`` when supplied (otherwise the backend default
 * applies). ``tolerance`` travels as ``--tolerance`` when supplied so a partial
 * rebuild facets like a document build. DAGMC and FEM mesh
 * export stay skipped exactly like {@link buildDocumentArgs} — partial
 * rebuilds are viewport-only operations.
 *
 * Exported for unit testing; callers should use {@link NukeCadBackendServiceImpl.buildFeaturesPartial}.
 */
export function buildFeaturesPartialArgs(request: BuildFeaturesPartialRequest, scriptPath: string): string[] {
    const args = [scriptPath, request.scriptPath, '--from-document', '--partial-feature-ids', request.featureIds.join(',')];
    // Viewport-only, like document builds: skip expensive DAGMC/mesh export.
    args.push('--no-dagmc', '--no-mesh');
    if (request.cacheDir !== undefined && request.cacheDir.length > 0) {
        args.push('--cache-dir', request.cacheDir);
    }
    if (request.tolerance !== undefined) {
        args.push('--tolerance', String(request.tolerance));
    }
    if (request.sizeCapMB !== undefined) {
        args.push('--size-cap-mb', String(request.sizeCapMB));
    }
    return args;
}

/**
 * Build the argument list for ``python/geometry_service.py --from-drawing``
 * (Wave D2 drawing dispatch, reconciled to landed D1: append-only drawing
 * dispatch lives in `geometry_service.py`, `--sheet-id` selects the sheet).
 *
 * Exported for unit testing; callers should use {@link NukeCadBackendServiceImpl.buildDrawing}.
 */
export function buildDrawingArgs(request: DrawingBuildRequest, scriptPath: string): string[] {
    const args = [scriptPath, request.scriptPath, '--from-drawing', '--sheet-id', request.sheetId];
    if (request.outputDirectory) {
        args.push('--output-dir', request.outputDirectory);
    }
    return args;
}

/**
 * Build the argument list for ``python/geometry_service.py --inspect-import``.
 *
 * Inspection is a read-only metadata pass: the source travels as the
 * positional input, the optional unit overrides and solid cap travel as flags,
 * and no output/artifact flags are ever emitted.
 *
 * Exported for unit testing; callers should use {@link NukeCadBackendServiceImpl.inspectImportSource}.
 */
export function inspectImportArgs(request: InspectImportSourceRequest, scriptPath: string): string[] {
    const args = [scriptPath, request.sourcePath, '--inspect-import'];
    if (request.sourceUnit) {
        args.push('--source-unit', request.sourceUnit);
    }
    if (request.targetUnits) {
        args.push('--target-units', request.targetUnits);
    }
    if (request.maxSolids !== undefined) {
        args.push('--max-solids', String(request.maxSolids));
    }
    return args;
}

/**
 * Maximum characters of a service's stdout/stderr kept in memory, mirroring
 * openmc-studio's runner. The stdout-JSON services print their one small JSON
 * summary line last, so keeping only the trailing 1 MB preserves the backwards
 * scan for the final JSON line while bounding memory for chatty services.
 */
const MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024;

/** Prefix the Python services put before their final JSON result line. */
const RESULT_MARKER = '__NUKE_RESULT__';

/** Append a chunk to a captured-output buffer, keeping only the trailing {@link MAX_CAPTURED_OUTPUT_CHARS} characters. */
function appendOutputTail(buffer: string, chunk: string): string {
    const combined = buffer + chunk;
    return combined.length > MAX_CAPTURED_OUTPUT_CHARS ? combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS) : combined;
}

/**
 * Capture a service's stdout for protocol parsing.
 *
 * The retained diagnostic tail is bounded, but a drawing result line carries
 * the full SVG/DXF payload and can exceed that tail. Losing the marker at the
 * start of such a line makes a successful exit (code 0) look like a service
 * failure, so the final marker line is kept whole while the tail stays bounded.
 */
export class ServiceResultCapture {
    private tail = '';
    private pending = '';
    private lastResultLine: string | undefined;

    append(chunk: string): void {
        this.tail = appendOutputTail(this.tail, chunk);
        this.pending += chunk;
        let newline = this.pending.indexOf('\n');
        while (newline >= 0) {
            this.consumeLine(this.pending.slice(0, newline));
            this.pending = this.pending.slice(newline + 1);
            newline = this.pending.indexOf('\n');
        }
    }

    /** Flush a final result line that arrived without a trailing newline. */
    finish(): void {
        if (this.pending.length > 0) {
            this.consumeLine(this.pending);
            this.pending = '';
        }
    }

    /** Bounded stdout tail for diagnostics and legacy result scanning. */
    get output(): string {
        return this.tail;
    }

    /** Complete final marker line, or undefined when the service printed none. */
    get resultLine(): string | undefined {
        return this.lastResultLine;
    }

    private consumeLine(line: string): void {
        const trimmed = line.trim();
        if (trimmed.startsWith(RESULT_MARKER)) {
            this.lastResultLine = trimmed;
        }
    }
}

/** Per-spawn options for {@link NukeCadBackendServiceImpl._spawnJsonService}. */
interface SpawnJobOptions {
    /** Job id for the process registry; generated when omitted. */
    jobId?: string;
    /** Process timeout in seconds; the backend default applies when omitted. */
    timeoutSeconds?: number;
}

/** A spawned Python service tracked for cancellation, timeout, and shutdown. */
interface RunningCadJob {
    jobId: string;
    process: ChildProcess;
    timer?: NodeJS.Timeout;
    cancelled: boolean;
    timedOut: boolean;
}

/** Hard cap for a backend sample download (the W7-X STEP is ~47 MB). */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** Default timeout for a backend-side sample download. */
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 300;
/** Maximum redirects followed while downloading a sample source. */
const MAX_DOWNLOAD_REDIRECTS = 5;

/**
 * Accept HTTPS sources and loopback HTTP only.
 *
 * Loopback HTTP keeps the backend download testable with a local test server;
 * production sample metadata always uses HTTPS.
 */
export function isAllowedDownloadUrl(url: URL): boolean {
    if (url.protocol === 'https:') {
        return true;
    }
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/** Resolve a download response, following redirects within the URL policy. */
function getDownloadResponse(url: URL, redirectsLeft: number, timeoutMs: number): Promise<http.IncomingMessage> {
    return new Promise<http.IncomingMessage>((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.get(
            url,
            {
                headers: {
                    'User-Agent': 'NukeIDE CAD sample downloader',
                    Accept: 'application/octet-stream, */*'
                }
            },
            (response) => {
                const status = response.statusCode ?? 0;
                const locationHeader = response.headers.location;
                const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
                if (status >= 300 && status < 400 && location !== undefined) {
                    response.resume();
                    if (redirectsLeft <= 0) {
                        reject(new Error('Too many download redirects.'));
                        return;
                    }
                    let next: URL;
                    try {
                        next = new URL(location, url);
                    } catch {
                        reject(new Error(`Invalid download redirect: ${location}`));
                        return;
                    }
                    if (!isAllowedDownloadUrl(next)) {
                        reject(new Error(`Download redirect is not allowed: ${next.toString()}`));
                        return;
                    }
                    resolve(getDownloadResponse(next, redirectsLeft - 1, timeoutMs));
                    return;
                }
                if (status !== 200) {
                    response.resume();
                    reject(new Error(`HTTP ${status} ${response.statusMessage ?? ''}`.trim()));
                    return;
                }
                resolve(response);
            }
        );
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`Download timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        });
        request.on('error', reject);
    });
}

/** Raw JSON record returned by the Python inspection CLI (before normalization). */
type RawInspectRecord = Record<string, unknown>;

function asInspectRecord(value: unknown): RawInspectRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    return value as RawInspectRecord;
}

function pickString(record: RawInspectRecord, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function pickNumber(record: RawInspectRecord, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}

function pickNumberArray(record: RawInspectRecord, ...keys: string[]): number[] | undefined {
    for (const key of keys) {
        const value = record[key];
        if (Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
            return value as number[];
        }
    }
    return undefined;
}

function pickStringArray(record: RawInspectRecord, ...keys: string[]): string[] | undefined {
    for (const key of keys) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value.filter((entry): entry is string => typeof entry === 'string');
        }
    }
    return undefined;
}

const IMPORT_SOURCE_FORMATS: readonly ImportSourceFormat[] = ['step', 'iges', 'brep'];

function toImportSourceFormat(value: string | undefined): ImportSourceFormat | undefined {
    const normalized = value?.toLowerCase();
    return IMPORT_SOURCE_FORMATS.find((format) => format === normalized);
}

/** Normalize one Python/exchange-reader solid record to the RPC shape. */
function normalizeImportSolid(value: unknown, fallbackIndex: number): ImportSolidInfo | undefined {
    const record = asInspectRecord(value);
    if (!record) {
        return undefined;
    }
    const name = pickString(record, 'name');
    return {
        index: pickNumber(record, 'index') ?? fallbackIndex,
        ...(name !== undefined ? { name } : {}),
        faceCount: pickNumber(record, 'faceCount', 'face_count') ?? 0,
        volume: pickNumber(record, 'volume') ?? 0,
        bboxMin: pickNumberArray(record, 'bboxMin', 'bbox_min') ?? [],
        bboxMax: pickNumberArray(record, 'bboxMax', 'bbox_max') ?? [],
        center: pickNumberArray(record, 'center') ?? []
    };
}

/**
 * Normalize the Python inspection payload to {@link InspectImportSourceResult}.
 *
 * The CLI contract is camelCase, matching the existing geometry-service JSON
 * results. The snake_case aliases mirror ``exchange_reader.ImportSource`` /
 * ``ImportSolidInfo`` field names so the RPC stays usable while the TS and
 * Python halves of the import feature land independently.
 */
export function normalizeInspectImportResult(raw: unknown, fallbackSourcePath: string): InspectImportSourceResult {
    const record = asInspectRecord(raw);
    if (!record) {
        return { success: false, error: 'Import inspection returned an invalid response.', sourcePath: fallbackSourcePath };
    }
    const error = pickString(record, 'error');
    const solidsRaw = record.solids;
    const solids = Array.isArray(solidsRaw)
        ? solidsRaw
              .map((solid, index) => normalizeImportSolid(solid, index + 1))
              .filter((solid): solid is ImportSolidInfo => solid !== undefined)
        : undefined;
    const sourceFormat = toImportSourceFormat(pickString(record, 'sourceFormat', 'source_format', 'format'));
    const sourcePath = pickString(record, 'sourcePath', 'source_path', 'path') ?? fallbackSourcePath;
    const sourceHash = pickString(record, 'sourceHash', 'source_hash', 'digest', 'hash');
    const sourceSize = pickNumber(record, 'sourceSize', 'source_size', 'size');
    const fileUnit = pickString(record, 'fileUnit', 'file_unit');
    const effectiveUnit = pickString(record, 'effectiveUnit', 'effective_unit');
    const unitScaleFactor = pickNumber(record, 'unitScaleFactor', 'unitScale', 'unit_scale', 'scale');
    const unitsMessage = pickString(record, 'unitsMessage', 'units_message');
    const solidCount = pickNumber(record, 'solidCount', 'solid_count') ?? solids?.length;
    const warnings = pickStringArray(record, 'warnings');
    return {
        success: record.success === undefined ? error === undefined : record.success === true,
        ...(error !== undefined ? { error } : {}),
        sourcePath,
        ...(sourceFormat !== undefined ? { sourceFormat } : {}),
        ...(sourceHash !== undefined ? { sourceHash } : {}),
        ...(sourceSize !== undefined ? { sourceSize } : {}),
        ...(fileUnit !== undefined ? { fileUnit } : {}),
        ...(effectiveUnit !== undefined ? { effectiveUnit } : {}),
        ...(unitScaleFactor !== undefined ? { unitScaleFactor } : {}),
        ...(unitsMessage !== undefined ? { unitsMessage } : {}),
        ...(solidCount !== undefined ? { solidCount } : {}),
        ...(solids !== undefined ? { solids } : {}),
        ...(warnings !== undefined ? { warnings } : {})
    };
}

@injectable()
export class NukeCadBackendServiceImpl implements NukeCadBackendService {
    /** Default backend process timeout: one hour (ccx/gmsh runs can be long). */
    protected static readonly DEFAULT_PROCESS_TIMEOUT_SECONDS = 3600;

    /** Timeout for quick metadata spawns (material/solver lists). */
    protected static readonly LIST_TIMEOUT_SECONDS = 30;

    /** Timeout for import-source inspection (reads and measures every source solid). */
    protected static readonly INSPECT_TIMEOUT_SECONDS = 300;

    /** Disambiguates temp request files from concurrent calls. */
    private static tempFileCounter = 0;

    private static jobCounter = 0;

    private readonly runningJobs = new Map<string, RunningCadJob>();

    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    /**
     * Build geometry by invoking ``python/geometry_service.py``.
     */
    async buildGeometry(request: GeometryBuildRequest): Promise<GeometryBuildResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'geometry_service.py' });
        if (!scriptPath) {
            return {
                success: false,
                error: 'Geometry service script not found.',
                scriptPath: request.scriptPath
            };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.',
                scriptPath: request.scriptPath
            };
        }

        const args = buildGeometryArgs(request, scriptPath);
        return this._spawnJsonService<GeometryBuildResult>(pythonCommand, args, path.dirname(request.scriptPath), request.scriptPath);
    }

    /**
     * Build geometry from a ``.nuke-cad`` document by invoking ``python/geometry_service.py``
     * with ``--from-document``.
     */
    async buildDocument(request: BuildDocumentRequest): Promise<GeometryBuildResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'geometry_service.py' });
        if (!scriptPath) {
            return {
                success: false,
                error: 'Geometry service script not found.',
                scriptPath: request.scriptPath
            };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.',
                scriptPath: request.scriptPath
            };
        }

        const args = buildDocumentArgs(request, scriptPath);
        return this._spawnJsonService<GeometryBuildResult>(pythonCommand, args, path.dirname(request.scriptPath), request.scriptPath);
    }

    /**
     * Rebuild only ``request.featureIds`` of a ``.nuke-cad`` document against
     * the result-cache sidecar (pass-through to ``geometry_service.py``; the
     * Python backend owns cache IO, predecessor-shape injection, and topo
     * order within the closure).
     */
    async buildFeaturesPartial(request: BuildFeaturesPartialRequest): Promise<GeometryBuildResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'geometry_service.py' });
        if (!scriptPath) {
            return {
                success: false,
                error: 'Geometry service script not found.',
                scriptPath: request.scriptPath
            };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.',
                scriptPath: request.scriptPath
            };
        }

        const args = buildFeaturesPartialArgs(request, scriptPath);
        return this._spawnJsonService<GeometryBuildResult>(pythonCommand, args, path.dirname(request.scriptPath), request.scriptPath, {
            jobId: request.jobId
        });
    }

    /**
     * Build one drawing sheet's HLR linework (Wave D2, brief §3).
     *
     * Drawing-only passthrough to ``python/geometry_service.py
     * --from-drawing``: dirty drawing state triggers this RPC, never a
     * full geometry rebuild.
     */
    async buildDrawing(request: DrawingBuildRequest): Promise<DrawingBuildResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'geometry_service.py' });
        if (!scriptPath) {
            return {
                success: false,
                error: 'Geometry service script not found.'
            };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.'
            };
        }

        const args = buildDrawingArgs(request, scriptPath);
        return this._spawnJsonService<DrawingBuildResult>(pythonCommand, args, path.dirname(request.scriptPath));
    }

    /**
     * Inspect an external STEP/IGES/BREP source without building it.
     *
     * The Python service streams the source hash/size, resolves the file and
     * target units, and enumerates explorer-order solids (name, faces, volume,
     * bbox, center). Nothing is written: no STEP/tessellation/DAGMC artifacts.
     */
    async inspectImportSource(request: InspectImportSourceRequest): Promise<InspectImportSourceResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'geometry_service.py' });
        if (!scriptPath) {
            return { success: false, error: 'Geometry service script not found.', sourcePath: request.sourcePath };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.',
                sourcePath: request.sourcePath
            };
        }

        const args = inspectImportArgs(request, scriptPath);
        const result = await this._spawnJsonService<InspectImportSourceResult>(
            pythonCommand,
            args,
            path.dirname(request.sourcePath),
            request.sourcePath,
            { timeoutSeconds: NukeCadBackendServiceImpl.INSPECT_TIMEOUT_SECONDS }
        );
        return normalizeInspectImportResult(result, request.sourcePath);
    }

    /**
     * Download a remote sample/source file through the Node host network and
     * write it to `targetPath`.
     *
     * The browser renderer can be behind a proxy, content blocker, or a CORS
     * policy that rejects a direct `fetch`; the backend avoids all three. The
     * response is streamed through a size limiter into a temporary file and
     * copied into place only after the transfer completes.
     */
    async downloadFile(request: DownloadFileRequest): Promise<DownloadFileResult> {
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            return { success: false, error: `Invalid download URL: ${request.url}` };
        }
        if (!isAllowedDownloadUrl(url)) {
            return { success: false, error: 'Download URL must use HTTPS (HTTP is allowed for loopback only).' };
        }
        if (!path.isAbsolute(request.targetPath)) {
            return { success: false, error: 'Download target must be an absolute path.' };
        }
        const target = path.normalize(request.targetPath);
        const temp = `${target}.download-${process.pid}-${Date.now()}`;
        const timeoutMs = Math.max(1, request.timeoutSeconds ?? DEFAULT_DOWNLOAD_TIMEOUT_SECONDS) * 1000;
        try {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const response = await getDownloadResponse(url, MAX_DOWNLOAD_REDIRECTS, timeoutMs);
            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
                response.destroy();
                throw new Error(`Download is too large (${declaredLength} bytes; limit ${MAX_DOWNLOAD_BYTES}).`);
            }
            let bytes = 0;
            const limiter = new Transform({
                transform(chunk: Buffer, _encoding, callback): void {
                    bytes += chunk.length;
                    if (bytes > MAX_DOWNLOAD_BYTES) {
                        callback(new Error(`Download exceeds the ${MAX_DOWNLOAD_BYTES}-byte limit.`));
                        return;
                    }
                    callback(null, chunk);
                }
            });
            await pipeline(response, limiter, fs.createWriteStream(temp));
            await fs.promises.copyFile(temp, target);
            await fs.promises.rm(temp, { force: true });
            return { success: true, path: target, bytes };
        } catch (error) {
            await fs.promises.rm(temp, { force: true }).catch(() => undefined);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * Spawn a Python service that emits a JSON result on stdout and return the
     * parsed object.  Diagnostics on stderr are forwarded into the result's
     * ``output`` field when the service does not provide one.
     *
     * The child is registered under a job id so it can be cancelled via
     * {@link cancelJob}, is killed after ``options.timeoutSeconds`` (default
     * {@link NukeCadBackendServiceImpl.DEFAULT_PROCESS_TIMEOUT_SECONDS}), and is
     * killed on application stop. The job id is echoed back on the result.
     */
    private async _spawnJsonService<T extends { success?: boolean; output?: string; error?: string }>(
        pythonCommand: string,
        args: string[],
        cwd: string,
        scriptPath?: string,
        options: SpawnJobOptions = {}
    ): Promise<T> {
        const { spawn } = await import('child_process');
        const jobId = options.jobId ?? `cad-job-${Date.now()}-${NukeCadBackendServiceImpl.jobCounter++}`;
        const timeoutSeconds = options.timeoutSeconds ?? NukeCadBackendServiceImpl.DEFAULT_PROCESS_TIMEOUT_SECONDS;

        return new Promise<T>((resolve) => {
            const child = spawn(pythonCommand, args, {
                cwd,
                env: this.buildPythonEnvironment(pythonCommand),
                stdio: ['ignore', 'pipe', 'pipe'],
                // Own process group on POSIX so cancellation/timeout can kill the
                // whole tree (the service may exec long-running ccx/gmsh children).
                detached: process.platform !== 'win32'
            });

            const stdout = new ServiceResultCapture();
            let stderr = '';

            const job: RunningCadJob = { jobId, process: child, cancelled: false, timedOut: false };

            const finish = (result: T): void => {
                if (job.timer) {
                    clearTimeout(job.timer);
                }
                this.runningJobs.delete(jobId);
                resolve(result);
            };

            job.timer = setTimeout(() => {
                job.timedOut = true;
                console.warn(`[NukeCad] Job ${jobId} timed out after ${timeoutSeconds}s; killing process tree.`);
                this.killJob(job);
            }, timeoutSeconds * 1000);
            job.timer.unref?.();
            this.runningJobs.set(jobId, job);

            child.stdout?.on('data', (data: Buffer) => {
                stdout.append(data.toString());
            });

            child.stderr?.on('data', (data: Buffer) => {
                stderr = appendOutputTail(stderr, data.toString());
            });

            child.on('error', (error) => {
                const result = {
                    success: false,
                    error: `Failed to start service: ${error.message}`,
                    output: stderr
                } as unknown as T;
                (result as any).jobId = jobId;
                if (scriptPath !== undefined) {
                    (result as any).scriptPath = scriptPath;
                }
                finish(result);
            });

            child.on('close', (code) => {
                stdout.finish();
                const lifecycleError = job.cancelled
                    ? 'Job cancelled.'
                    : job.timedOut
                      ? `Job timed out after ${timeoutSeconds} seconds.`
                      : undefined;
                const resultLine = stdout.resultLine;
                if (resultLine !== undefined) {
                    try {
                        const parsed = JSON.parse(resultLine.slice(RESULT_MARKER.length)) as T;
                        const success = lifecycleError ? false : code !== 0 && parsed.success !== false ? false : parsed.success;
                        const result: T = {
                            ...parsed,
                            success,
                            error:
                                lifecycleError ?? (success === false ? parsed.error || `Process exited with code ${code}` : parsed.error),
                            output: parsed.output ?? stderr
                        };
                        (result as any).jobId = jobId;
                        if (scriptPath !== undefined) {
                            (result as any).scriptPath = scriptPath;
                        }
                        finish(result);
                        return;
                    } catch {
                        // Malformed result line: fall through to the legacy tail scan.
                    }
                }
                const lines = stdout.output.trim().split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    const candidate = lines[i].trim();
                    if (!candidate.startsWith(RESULT_MARKER)) {
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(candidate.slice(RESULT_MARKER.length)) as T;
                        const success = lifecycleError ? false : code !== 0 && parsed.success !== false ? false : parsed.success;
                        const result: T = {
                            ...parsed,
                            success,
                            error:
                                lifecycleError ?? (success === false ? parsed.error || `Process exited with code ${code}` : parsed.error),
                            output: parsed.output ?? stderr
                        };
                        (result as any).jobId = jobId;
                        if (scriptPath !== undefined) {
                            (result as any).scriptPath = scriptPath;
                        }
                        finish(result);
                        return;
                    } catch {
                        // Not JSON; keep scanning backwards.
                    }
                }

                const detail = stderr.trim() || stdout.output.trim();
                const result = {
                    success: false,
                    error: lifecycleError ?? `Service exited with code ${code}${detail ? `: ${detail.slice(-500)}` : ''}`,
                    output: stderr
                } as unknown as T;
                (result as any).jobId = jobId;
                if (scriptPath !== undefined) {
                    (result as any).scriptPath = scriptPath;
                }
                finish(result);
            });
        });
    }

    /**
     * Build the child environment with the Python interpreter's bin directory
     * prepended to PATH so the service can find its sibling executables.
     */
    private buildPythonEnvironment(pythonCommand: string): NodeJS.ProcessEnv {
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) ? currentPath : `${pythonBinDir}${path.delimiter}${currentPath}`;
        return { ...process.env, PATH: newPath };
    }

    /**
     * Kill a running job's whole process tree. On POSIX the child was spawned
     * detached and leads its own process group, so signal the group; on Windows
     * fall back to killing the direct child.
     */
    private killJob(job: RunningCadJob): void {
        const child = job.process;
        try {
            if (process.platform !== 'win32' && child.pid !== undefined) {
                process.kill(-child.pid, 'SIGTERM');
            } else {
                child.kill();
            }
        } catch {
            // Process group already gone; best-effort direct kill.
            try {
                child.kill();
            } catch {
                // Process already exited.
            }
        }
    }

    /**
     * Cancel a running job started via {@link runFem} or {@link runJob}.
     * The pending call resolves with ``success: false`` and a cancellation error.
     */
    async cancelJob(jobId: string): Promise<boolean> {
        const job = this.runningJobs.get(jobId);
        if (!job) {
            return false;
        }
        job.cancelled = true;
        this.killJob(job);
        return true;
    }

    /** BackendApplicationContribution hook: kill any jobs still running on shutdown. */
    onStop(): void {
        for (const job of this.runningJobs.values()) {
            job.cancelled = true;
            this.killJob(job);
        }
        this.runningJobs.clear();
    }

    /**
     * Run the FEM service: write a CalculiX input deck and optionally run ccx.
     */
    async runFem(request: FemRunRequest): Promise<FemRunResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'fem_service.py' });
        if (!scriptPath) {
            return { success: false, error: 'FEM service script not found.' };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.'
            };
        }

        const requestPath = path.join(
            path.dirname(request.mshPath),
            `.nuke-cad-fem-request-${Date.now()}-${NukeCadBackendServiceImpl.tempFileCounter++}.json`
        );
        fs.writeFileSync(
            requestPath,
            JSON.stringify({
                mshPath: request.mshPath,
                outputDir: path.dirname(request.mshPath),
                materials: request.materials,
                boundaryConditions: request.boundaryConditions,
                step: request.step,
                run: request.run ?? true,
                ccxPath: request.ccxPath
            }),
            'utf-8'
        );

        try {
            return await this._spawnJsonService<FemRunResult>(
                pythonCommand,
                [scriptPath, '--request', requestPath],
                path.dirname(request.mshPath),
                undefined,
                { jobId: request.jobId, timeoutSeconds: request.processTimeoutSeconds }
            );
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
    }

    /**
     * Return the built-in FEM material database from the Python service.
     */
    async listFemMaterials(): Promise<FemMaterial[]> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'fem_service.py' });
        if (!scriptPath) {
            return [];
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return [];
        }

        const { spawn } = await import('child_process');

        return new Promise<FemMaterial[]>((resolve) => {
            const child = spawn(pythonCommand, [scriptPath, '--list-materials'], {
                env: this.buildPythonEnvironment(pythonCommand),
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Panel metadata call: bound the wait so a hung interpreter cannot pin the promise forever.
            const timer = setTimeout(() => {
                child.kill();
            }, NukeCadBackendServiceImpl.LIST_TIMEOUT_SECONDS * 1000);
            timer.unref?.();

            let stdout = '';
            child.stdout?.on('data', (data: Buffer) => {
                stdout = appendOutputTail(stdout, data.toString());
            });

            child.on('close', () => {
                clearTimeout(timer);
                try {
                    const parsed = JSON.parse(stdout);
                    resolve(Object.values(parsed) as FemMaterial[]);
                } catch {
                    resolve([]);
                }
            });

            child.on('error', () => {
                clearTimeout(timer);
                resolve([]);
            });
        });
    }

    /**
     * Run a declarative job through the generic nuke-cad job runner.
     */
    async runJob(request: JobRunRequest): Promise<JobRunResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'job_service.py' });
        if (!scriptPath) {
            return { success: false, error: 'Job service script not found.', artifacts: [] };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.',
                artifacts: []
            };
        }

        // The protocol promises the working directory is created if missing;
        // the request file is written into it before the service runs.
        fs.mkdirSync(request.workingDirectory, { recursive: true });
        const requestPath = path.join(
            request.workingDirectory,
            `.nuke-cad-job-request-${Date.now()}-${NukeCadBackendServiceImpl.tempFileCounter++}.json`
        );
        fs.writeFileSync(requestPath, JSON.stringify(request), 'utf-8');

        try {
            return await this._spawnJsonService<JobRunResult>(
                pythonCommand,
                [scriptPath, '--request', requestPath],
                request.workingDirectory,
                undefined,
                { jobId: request.jobId, timeoutSeconds: request.processTimeoutSeconds }
            );
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
    }

    /**
     * Scaffold a new OpenFOAM case directory.
     */
    async buildFoamCase(request: FoamCaseRequest): Promise<FoamCaseResult> {
        return this._spawnFoamService<FoamCaseResult>(request, { operation: 'buildCase', ...request });
    }

    /**
     * Export per-solid STL files from a STEP file.
     */
    async exportFoamStl(request: FoamStlExportRequest): Promise<FoamStlExportResult> {
        return this._spawnFoamService<FoamStlExportResult>(request, { operation: 'exportStl', ...request });
    }

    /**
     * Return the built-in OpenFOAM solver template names.
     */
    async listFoamSolvers(): Promise<string[]> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'foam_service.py' });
        if (!scriptPath) {
            return [];
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return [];
        }

        // Temp request files go to the OS temp dir: the installed extension
        // directory (scriptPath's parent) is read-only in packaged Electron.
        const requestPath = path.join(os.tmpdir(), `.nuke-cad-foam-list-${Date.now()}-${NukeCadBackendServiceImpl.tempFileCounter++}.json`);
        fs.writeFileSync(requestPath, JSON.stringify({ operation: 'listSolvers', caseDir: path.dirname(scriptPath) }), 'utf-8');

        try {
            const result = await this._spawnJsonService<{ success: boolean; solvers?: string[]; error?: string }>(
                pythonCommand,
                [scriptPath, '--request', requestPath],
                path.dirname(scriptPath),
                undefined,
                // Panel metadata call: bound the wait so a hung interpreter cannot pin the promise forever.
                { timeoutSeconds: NukeCadBackendServiceImpl.LIST_TIMEOUT_SECONDS }
            );
            return result.success && result.solvers ? result.solvers : [];
        } catch {
            return [];
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
    }

    /**
     * Helper to spawn foam_service.py with a JSON request file.
     */
    private async _spawnFoamService<T extends { success: boolean; error?: string }>(
        request: { caseDir?: string; stepPath?: string },
        payload: Record<string, unknown>
    ): Promise<T> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'foam_service.py' });
        if (!scriptPath) {
            return { success: false, error: 'OpenFOAM service script not found.' } as unknown as T;
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.'
            } as unknown as T;
        }

        const workingDirectory = request.caseDir
            ? path.dirname(request.caseDir)
            : request.stepPath
              ? path.dirname(request.stepPath)
              : path.dirname(scriptPath);
        // The request file itself goes to the OS temp dir: the fallback working
        // directory above is the installed extension dir, read-only in packaged
        // Electron, and Date.now() names can collide across concurrent calls.
        const requestPath = path.join(
            os.tmpdir(),
            `.nuke-cad-foam-request-${Date.now()}-${NukeCadBackendServiceImpl.tempFileCounter++}.json`
        );
        fs.writeFileSync(requestPath, JSON.stringify(payload), 'utf-8');

        try {
            return await this._spawnJsonService<T>(pythonCommand, [scriptPath, '--request', requestPath], workingDirectory);
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
    }

    /**
     * Verify that the active environment has the CAD toolchain.
     */
    async checkCadEnvironment(): Promise<{ ready: boolean; missing: string[]; missingOptional: string[] }> {
        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return { ready: false, missing: ['python'], missingOptional: [] };
        }

        const check = await this.nukeCoreService.checkDependencies(CAD_HEALTH_PACKAGES, pythonCommand);
        // nuke-core only counts required packages into `missing`; surface absent
        // optional packages separately so the health check stays informative.
        const missingOptional = CAD_HEALTH_PACKAGES.filter((pkg) => pkg.required === false && !(pkg.name in check.versions)).map(
            (pkg) => pkg.name
        );
        return { ready: check.available, missing: check.missing, missingOptional };
    }
}
