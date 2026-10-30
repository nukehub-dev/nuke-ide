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
import { buildOpenMCRunCommand, buildPythonDriverCommand, describeParallelism } from '../common/openmc-run-command';

describe('OpenMC run command construction', () => {
    it('runs serially without runtime flags when nothing is configured', () => {
        expect(buildOpenMCRunCommand({ openmcExecutable: '/env/bin/openmc' })).toEqual({
            command: '/env/bin/openmc',
            args: []
        });
    });

    it('passes OpenMP threads as -s N before restart and extra args', () => {
        expect(
            buildOpenMCRunCommand({
                openmcExecutable: '/env/bin/openmc',
                threads: 4,
                restartFile: 'statepoint.10.h5',
                extraArgs: ['-t']
            })
        ).toEqual({
            command: '/env/bin/openmc',
            args: ['-s', '4', '-r', 'statepoint.10.h5', '-t']
        });
    });

    it('wraps the binary in mpirun with process count and threads', () => {
        expect(
            buildOpenMCRunCommand({
                openmcExecutable: '/env/bin/openmc',
                threads: 2,
                mpi: { enabled: true, processes: 8 }
            })
        ).toEqual({
            command: 'mpirun',
            args: ['-np', '8', '/env/bin/openmc', '-s', '2']
        });
    });

    it('passes an MPI host list to mpirun', () => {
        expect(
            buildOpenMCRunCommand({
                openmcExecutable: 'openmc',
                mpi: { enabled: true, processes: 2, hosts: ['node1', 'node2'] }
            })
        ).toEqual({
            command: 'mpirun',
            args: ['-np', '2', '--host', 'node1,node2', 'openmc']
        });
    });

    it('falls back to a serial launch for a single MPI process', () => {
        expect(
            buildOpenMCRunCommand({
                openmcExecutable: 'openmc',
                mpi: { enabled: true, processes: 1 }
            })
        ).toEqual({ command: 'openmc', args: [] });
    });

    it('ignores non-positive thread and process values', () => {
        expect(
            buildOpenMCRunCommand({
                openmcExecutable: 'openmc',
                threads: 0,
                mpi: { enabled: true, processes: 0 }
            })
        ).toEqual({ command: 'openmc', args: [] });
    });

    it('wraps Python drivers in mpirun and keeps driver args', () => {
        expect(buildPythonDriverCommand('/env/bin/python', ['run_depletion.py', '/run'], { enabled: true, processes: 3 })).toEqual({
            command: 'mpirun',
            args: ['-np', '3', '/env/bin/python', 'run_depletion.py', '/run']
        });
    });

    it('describes threads and MPI for logs and the run summary', () => {
        expect(describeParallelism(undefined, undefined)).toBe('OpenMC default parallelism');
        expect(describeParallelism(4, { enabled: false })).toBe('4 OpenMP threads');
        expect(describeParallelism(2, { enabled: true, processes: 8 })).toBe('8 MPI ranks x 2 OpenMP threads');
    });
});
