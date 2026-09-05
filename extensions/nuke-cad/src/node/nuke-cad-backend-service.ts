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
import * as os from 'os';
import * as path from 'path';

import {
    NukeCadBackendService,
    GeometryBuildRequest,
    GeometryBuildResult,
    BuildDocumentRequest,
    BuildFeaturesPartialRequest,
    FemRunRequest,
    FemRunResult,
    FemMaterial,
    JobRunRequest,
    JobRunResult,
    FoamCaseRequest,
    FoamCaseResult,
    FoamStlExportRequest,
    FoamStlExportResult
} from '../common/nuke-cad-protocol';
import { CAD_HEALTH_PACKAGES } from '../common/packages';

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
 * ``featureIds`` travel as a single comma-separated ``--partial-features``
 * argument; ``cacheDir`` travels as ``--cache-dir`` when supplied (otherwise
 * the backend defaults to the document file's directory). DAGMC and FEM mesh
 * export stay skipped exactly like {@link buildDocumentArgs} — partial
 * rebuilds are viewport-only operations.
 *
 * Exported for unit testing; callers should use {@link NukeCadBackendServiceImpl.buildFeaturesPartial}.
 */
export function buildFeaturesPartialArgs(request: BuildFeaturesPartialRequest, scriptPath: string): string[] {
    const args = [scriptPath, request.scriptPath, '--from-document', '--partial-features', request.featureIds.join(',')];
    // Viewport-only, like document builds: skip expensive DAGMC/mesh export.
    args.push('--no-dagmc', '--no-mesh');
    if (request.cacheDir !== undefined && request.cacheDir.length > 0) {
        args.push('--cache-dir', request.cacheDir);
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

/** Append a chunk to a captured-output buffer, keeping only the trailing {@link MAX_CAPTURED_OUTPUT_CHARS} characters. */
function appendOutputTail(buffer: string, chunk: string): string {
    const combined = buffer + chunk;
    return combined.length > MAX_CAPTURED_OUTPUT_CHARS ? combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS) : combined;
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

@injectable()
export class NukeCadBackendServiceImpl implements NukeCadBackendService {
    /** Default backend process timeout: one hour (ccx/gmsh runs can be long). */
    protected static readonly DEFAULT_PROCESS_TIMEOUT_SECONDS = 3600;

    /** Timeout for quick metadata spawns (material/solver lists). */
    protected static readonly LIST_TIMEOUT_SECONDS = 30;

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

            let stdout = '';
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
                stdout = appendOutputTail(stdout, data.toString());
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
                const lifecycleError = job.cancelled
                    ? 'Job cancelled.'
                    : job.timedOut
                      ? `Job timed out after ${timeoutSeconds} seconds.`
                      : undefined;
                const RESULT_MARKER = '__NUKE_RESULT__';
                const lines = stdout.trim().split('\n');
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

                const detail = stderr.trim() || stdout.trim();
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
