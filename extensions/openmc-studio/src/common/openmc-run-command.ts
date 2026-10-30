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
 * Pure construction of OpenMC process invocations.
 *
 * Runtime controls (OpenMP threads, MPI ranks, hosts) are command-line launch
 * details, not settings.xml content: OpenMC reads threads from `-s` at
 * process start and ranks from the `mpirun` launcher. Keeping the assembly
 * pure makes the exact argv unit-testable without spawning processes.
 *
 * @module openmc-studio/common
 */

import type { SimulationRunRequest } from './openmc-studio-protocol';

/** MPI launch controls from the run request. */
export type MpiLaunchConfig = NonNullable<SimulationRunRequest['mpi']>;

/** A resolved command and argv. */
export interface LaunchCommand {
    /** Executable or launcher (`openmc`, `mpirun`, or a Python interpreter). */
    command: string;
    /** Complete argument vector. */
    args: string[];
}

/** Inputs for an `openmc` binary invocation. */
export interface OpenMCCommandOptions {
    /** Resolved OpenMC executable path. */
    openmcExecutable: string;
    /** OpenMP threads per rank (`-s N`). */
    threads?: number;
    /** MPI launch controls. */
    mpi?: MpiLaunchConfig;
    /** Statepoint restart file (`-r FILE`). */
    restartFile?: string;
    /** Additional CLI arguments (for example `-t`). */
    extraArgs?: string[];
}

/**
 * Normalize a positive integer runtime count.
 * @param value - Candidate value.
 * @returns The integer when it is >= 1, otherwise undefined.
 */
function positiveInteger(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Build the `mpirun` prefix for a launch, or an empty prefix when MPI is not
 * actually enabled (disabled, missing, or a single process).
 * @param mpi - MPI configuration.
 * @returns Launcher command and its leading arguments.
 */
export function buildMpiLaunchPrefix(mpi?: MpiLaunchConfig): string[] {
    if (!mpi?.enabled) {
        return [];
    }
    const processes = positiveInteger(mpi.processes);
    if (processes === undefined || processes <= 1) {
        return [];
    }
    const prefix = ['mpirun', '-np', String(processes)];
    const hosts = (mpi.hosts ?? []).map((host) => host.trim()).filter((host) => host.length > 0);
    if (hosts.length > 0) {
        prefix.push('--host', hosts.join(','));
    }
    return prefix;
}

/**
 * Build an OpenMC binary invocation with threads and MPI applied.
 * @param options - Executable, threads, MPI, restart, and extra arguments.
 * @returns Resolved command and argv.
 */
export function buildOpenMCRunCommand(options: OpenMCCommandOptions): LaunchCommand {
    const prefix = buildMpiLaunchPrefix(options.mpi);
    const openmcArgs: string[] = [];
    const threads = positiveInteger(options.threads);
    if (threads !== undefined) {
        openmcArgs.push('-s', String(threads));
    }
    if (options.restartFile) {
        openmcArgs.push('-r', options.restartFile);
    }
    if (options.extraArgs) {
        openmcArgs.push(...options.extraArgs);
    }
    if (prefix.length > 0) {
        return { command: prefix[0], args: [...prefix.slice(1), options.openmcExecutable, ...openmcArgs] };
    }
    return { command: options.openmcExecutable, args: openmcArgs };
}

/**
 * Build a Python driver invocation, optionally wrapped in `mpirun`.
 * @param pythonCommand - Python interpreter path.
 * @param driverArgs - Script path followed by its arguments.
 * @param mpi - MPI launch controls.
 * @returns Resolved command and argv.
 */
export function buildPythonDriverCommand(pythonCommand: string, driverArgs: string[], mpi?: MpiLaunchConfig): LaunchCommand {
    const prefix = buildMpiLaunchPrefix(mpi);
    if (prefix.length > 0) {
        return { command: prefix[0], args: [...prefix.slice(1), pythonCommand, ...driverArgs] };
    }
    return { command: pythonCommand, args: driverArgs };
}

/**
 * Human-readable run summary for logs and the dashboard.
 * @param threads - OpenMP threads per rank.
 * @param mpi - MPI launch controls.
 * @returns Summary text such as `2 MPI ranks x 4 OpenMP threads`.
 */
export function describeParallelism(threads?: number, mpi?: MpiLaunchConfig): string {
    const processes = mpi?.enabled ? positiveInteger(mpi.processes) : undefined;
    const threadCount = positiveInteger(threads);
    if (processes !== undefined && processes > 1) {
        return `${processes} MPI ranks${threadCount !== undefined ? ` x ${threadCount} OpenMP threads` : ''}`;
    }
    return threadCount !== undefined ? `${threadCount} OpenMP threads` : 'OpenMC default parallelism';
}
