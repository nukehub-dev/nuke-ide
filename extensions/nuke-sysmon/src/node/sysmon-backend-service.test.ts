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

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { fsSizeMock, currentLoadMock, cpuTemperatureMock, readFileMock } = vi.hoisted(() => ({
    fsSizeMock: vi.fn(),
    currentLoadMock: vi.fn(),
    cpuTemperatureMock: vi.fn(),
    readFileMock: vi.fn()
}));

vi.mock('systeminformation', () => ({
    fsSize: fsSizeMock,
    currentLoad: currentLoadMock,
    cpuTemperature: cpuTemperatureMock
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, promises: { ...actual.promises, readFile: readFileMock } };
});

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

describe('SysmonBackendService cpu metrics', () => {
    interface CpuService {
        getCpuMetrics(): Promise<{ usagePercent: number }>;
        previousCgroupCpu: { usageNs: number; timestamp: number } | null;
    }

    const service = (): CpuService => new SysmonBackendService() as unknown as CpuService;

    const cgroupV2Files = (usageUsec: number, cpuMax = '1600000 100000'): Record<string, string> => ({
        '/sys/fs/cgroup/cpu.stat': `usage_usec ${usageUsec}\nuser_usec 0\nsystem_usec 0\n`,
        '/sys/fs/cgroup/cpu.max': `${cpuMax}\n`
    });

    const mockFiles = (files: Record<string, string>): void => {
        readFileMock.mockImplementation(async (path: string) => {
            if (path in files) {
                return files[path];
            }
            const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        });
    };

    beforeEach(() => {
        currentLoadMock.mockReset();
        cpuTemperatureMock.mockReset();
        readFileMock.mockReset();
        cpuTemperatureMock.mockResolvedValue({ main: undefined });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports container-scoped usage from cgroup v2 relative to the CPU quota', async () => {
        // Host is fully busy (currentLoad 100%) but the container's own
        // cgroup consumed 8 core-seconds over 1 wall-second on a 16-core
        // quota, so the expected reading is 50%, not 100%.
        currentLoadMock.mockResolvedValue({ currentLoad: 100, avgLoad: 32 });
        mockFiles(cgroupV2Files(16_000_000));

        const svc = service();
        svc.previousCgroupCpu = { usageNs: 8_000_000_000, timestamp: 1000 };
        vi.spyOn(Date, 'now').mockReturnValue(2000);

        const metrics = await svc.getCpuMetrics();

        expect(metrics.usagePercent).toBe(50);
    });

    it('reports 0% for an idle container even when the host CPU is saturated', async () => {
        // Regression test: si.currentLoad() reads host-wide /proc/stat and
        // must not leak into container metrics.
        currentLoadMock.mockResolvedValue({ currentLoad: 100, avgLoad: 32 });
        mockFiles(cgroupV2Files(8_000_100)); // ~0.1s of CPU over 1s wall

        const svc = service();
        svc.previousCgroupCpu = { usageNs: 8_000_000_000, timestamp: 1000 };
        vi.spyOn(Date, 'now').mockReturnValue(2000);

        const metrics = await svc.getCpuMetrics();

        expect(metrics.usagePercent).toBe(0);
    });

    it('reports 0% on the first cgroup sample (no delta available yet)', async () => {
        currentLoadMock.mockResolvedValue({ currentLoad: 100, avgLoad: 32 });
        mockFiles(cgroupV2Files(8_000_000));

        const svc = service();
        const metrics = await svc.getCpuMetrics();

        expect(metrics.usagePercent).toBe(0);
        expect(svc.previousCgroupCpu).toEqual({ usageNs: 8_000_000_000, timestamp: expect.any(Number) });
    });

    it('clamps container usage at 100% of the quota', async () => {
        currentLoadMock.mockResolvedValue({ currentLoad: 100, avgLoad: 32 });
        // 32 core-seconds over 1s wall on a 16-core quota (200%).
        mockFiles(cgroupV2Files(40_000_000));

        const svc = service();
        svc.previousCgroupCpu = { usageNs: 8_000_000_000, timestamp: 1000 };
        vi.spyOn(Date, 'now').mockReturnValue(2000);

        const metrics = await svc.getCpuMetrics();

        expect(metrics.usagePercent).toBe(100);
    });

    it('supports cgroup v1 cpuacct counters and cfs quota', async () => {
        currentLoadMock.mockResolvedValue({ currentLoad: 100, avgLoad: 32 });
        mockFiles({
            '/sys/fs/cgroup/cpuacct/cpuacct.usage': '16000000000\n',
            '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '800000\n',
            '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n'
        });

        const svc = service();
        // 4 core-seconds over 1s wall on an 8-core quota → 50%.
        svc.previousCgroupCpu = { usageNs: 12_000_000_000, timestamp: 1000 };
        vi.spyOn(Date, 'now').mockReturnValue(2000);

        const metrics = await svc.getCpuMetrics();

        expect(metrics.usagePercent).toBe(50);
    });

    it('derives the CPU count from the cpuset when no quota is set', async () => {
        currentLoadMock.mockResolvedValue({ currentLoad: 100, avgLoad: 32 });
        mockFiles({
            ...cgroupV2Files(10_000_000, 'max 100000'),
            '/sys/fs/cgroup/cpuset.cpus.effective': '0-3,8-11\n'
        });

        const svc = service();
        // 4 core-seconds over 1s wall on an 8-core cpuset → 50%.
        svc.previousCgroupCpu = { usageNs: 6_000_000_000, timestamp: 1000 };
        vi.spyOn(Date, 'now').mockReturnValue(2000);

        const metrics = await svc.getCpuMetrics();

        expect(metrics.usagePercent).toBe(50);
    });

    it('falls back to host-wide load when no cgroup limits exist (bare metal)', async () => {
        currentLoadMock.mockResolvedValue({ currentLoad: 42.4, avgLoad: 1.5 });
        mockFiles({});

        const svc = service();
        const metrics = await svc.getCpuMetrics();

        expect(metrics.usagePercent).toBe(42);
    });
});
