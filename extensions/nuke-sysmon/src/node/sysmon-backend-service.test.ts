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

/**
 * Tests for the disk filesystem selection in {@link SysmonBackendService}:
 * pseudo filesystems (tmpfs, squashfs, …) are excluded and real mounts such
 * as separately mounted volumes (/home/<user>) are listed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fsSizeMock } = vi.hoisted(() => ({ fsSizeMock: vi.fn() }));

vi.mock('systeminformation', () => ({ fsSize: fsSizeMock }));

import { SysmonBackendService } from './sysmon-backend-service';
import { DiskInfo } from './sysmon-backend-service';

const GIB = 1024 ** 3;

function entry(fs: string, type: string, sizeGiB: number, mount: string): object {
    return {
        fs,
        type,
        size: sizeGiB * GIB,
        used: 0.31 * sizeGiB * GIB,
        available: 0.69 * sizeGiB * GIB,
        use: 31,
        mount
    };
}

describe('SysmonBackendService disk metrics', () => {
    beforeEach(() => {
        fsSizeMock.mockReset();
    });

    it('lists real mounts and excludes pseudo filesystems', async () => {
        fsSizeMock.mockResolvedValue([
            entry('overlay', 'overlay', 200, '/'),
            entry('tmpfs', 'tmpfs', 32, '/dev'),
            entry('/dev/mapper/vg-data', 'xfs', 10, '/home/user'),
            entry('/dev/loop0', 'squashfs', 9.8, '/etc/hosts')
        ]);

        const service = new SysmonBackendService();
        const metrics = await (service as unknown as { getDiskMetrics(): Promise<{ total: number }> }).getDiskMetrics();
        const mounts = (service as unknown as { allDisks: DiskInfo[] }).allDisks.map((d) => d.mount);

        expect(mounts).toEqual(['/', '/home/user']);
        expect(metrics.total).toBe(200 * GIB);
    });

    it('drops mounts smaller than 1 GiB', async () => {
        fsSizeMock.mockResolvedValue([entry('overlay', 'overlay', 200, '/'), entry('/dev/sda4', 'ext4', 0.5, '/boot/efi')]);

        const service = new SysmonBackendService();
        await (service as unknown as { getDiskMetrics(): Promise<unknown> }).getDiskMetrics();
        const mounts = (service as unknown as { allDisks: DiskInfo[] }).allDisks.map((d) => d.mount);

        expect(mounts).toEqual(['/']);
    });
});
