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

import { injectable } from '@theia/core/shared/inversify';
import * as fs from 'fs';
import * as os from 'os';
import * as si from 'systeminformation';
import {
    SystemMetrics,
    CpuMetrics,
    MemoryMetrics,
    DiskMetrics,
    NetworkMetrics,
    SystemInfo,
    HistoricalData
} from '../common/sysmon-protocol';

export interface DiskInfo {
    fs: string;
    type: string;
    size: number;
    used: number;
    available: number;
    use: number;
    mount: string;
}

@injectable()
export class SysmonBackendService {
    private readonly historyLength = 60;
    private history: SystemMetrics[] = [];
    private updateInterval: NodeJS.Timeout | null = null;
    private callbacks: ((metrics: SystemMetrics) => void)[] = [];
    private allDisks: DiskInfo[] = [];
    private selectedDiskIndex: number = 0;
    private systemInfo: SystemInfo | null = null;
    private cpuInfo: { manufacturer: string; brand: string; speed: number; cores: number; physicalCores: number } | null = null;

    private previousNetworkStats: { bytesReceived: number; bytesSent: number; timestamp: number; iface: string } | null = null;

    // Last cgroup CPU counter sample, used to derive container-scoped usage.
    private previousCgroupCpu: { usageNs: number; timestamp: number } | null = null;

    async initialize(): Promise<void> {
        // Collect static system info once
        const [osInfo, cpuData, processes] = await Promise.all([si.osInfo(), si.cpu(), si.processes().catch(() => ({ all: 0 }))]);

        this.systemInfo = {
            hostname: osInfo.hostname,
            platform: osInfo.platform,
            distro: osInfo.distro,
            release: osInfo.release,
            arch: osInfo.arch,
            uptime: 0,
            processCount: processes.all
        };

        this.cpuInfo = {
            manufacturer: cpuData.manufacturer,
            brand: cpuData.brand,
            speed: cpuData.speed,
            cores: cpuData.cores,
            physicalCores: cpuData.physicalCores
        };
    }

    startMonitoring(intervalMs: number = 2000): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }

        this.collectMetrics();
        this.updateInterval = setInterval(() => {
            this.collectMetrics();
        }, intervalMs);
    }

    stopMonitoring(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    async getCurrentMetrics(): Promise<SystemMetrics> {
        if (this.history.length > 0) {
            return this.history[this.history.length - 1];
        }
        return this.collectMetrics();
    }

    getHistoricalData(points: number = this.historyLength): Promise<HistoricalData> {
        const data = this.history.slice(-points);
        const result: HistoricalData = {
            timestamps: data.map((m) => m.timestamp),
            cpu: data.map((m) => m.cpu.usagePercent),
            memory: data.map((m) => m.memory.usagePercent),
            networkDownload: data.map((m) => m.network.downloadSpeed),
            networkUpload: data.map((m) => m.network.uploadSpeed)
        };
        return Promise.resolve(result);
    }

    getAllDisks(): Promise<DiskInfo[]> {
        return Promise.resolve(this.allDisks);
    }

    setSelectedDisk(index: number): void {
        if (index >= 0 && index < this.allDisks.length) {
            this.selectedDiskIndex = index;
        }
    }

    getSelectedDiskIndex(): number {
        return this.selectedDiskIndex;
    }

    onMetricsUpdated(callback: (metrics: SystemMetrics) => void): void {
        this.callbacks.push(callback);
    }

    private async collectMetrics(): Promise<SystemMetrics> {
        // Initialize on first call if needed
        if (!this.systemInfo) {
            await this.initialize();
        }

        try {
            const [cpu, mem, disk, network, processes] = await Promise.all([
                this.getCpuMetrics(),
                this.getMemoryMetrics(),
                this.getDiskMetrics(),
                this.getNetworkMetrics(),
                si.processes().catch(() => ({ all: 0 }))
            ]);

            // Update system info with current uptime and process count
            const sysInfo: SystemInfo = {
                ...this.systemInfo!,
                uptime: Math.floor(process.uptime()),
                processCount: processes.all
            };

            const metrics: SystemMetrics = {
                timestamp: Date.now(),
                cpu,
                memory: mem,
                disk,
                network,
                system: sysInfo
            };

            this.history.push(metrics);
            if (this.history.length > this.historyLength) {
                this.history.shift();
            }

            this.callbacks.forEach((cb) => {
                try {
                    cb(metrics);
                } catch (e) {
                    console.error('Error in metrics callback:', e);
                }
            });

            return metrics;
        } catch (error) {
            console.error('Error collecting system metrics:', error);
            throw error;
        }
    }

    private async getCpuMetrics(): Promise<CpuMetrics> {
        const [currentLoad, cpuTemperature, cgroupUsageNs, allocatedCpus] = await Promise.all([
            si.currentLoad(),
            si.cpuTemperature().catch(() => ({ main: undefined })) as Promise<{ main?: number }>,
            this.readCgroupCpuUsageNs(),
            this.getAllocatedCpuCount()
        ]);

        let usagePercent: number;
        if (cgroupUsageNs !== null && allocatedCpus !== null) {
            // Container-scoped: /proc/stat (used by si.currentLoad) reports
            // host-wide CPU, which is meaningless inside a container. Derive
            // usage from the cgroup CPU counter instead, relative to the
            // container's CPU quota, so 100% means all allocated cores busy.
            usagePercent = 0;
            const now = Date.now();
            if (this.previousCgroupCpu) {
                const usageDeltaNs = cgroupUsageNs - this.previousCgroupCpu.usageNs;
                const timeDeltaNs = (now - this.previousCgroupCpu.timestamp) * 1e6;
                if (usageDeltaNs >= 0 && timeDeltaNs > 0) {
                    usagePercent = Math.min(100, Math.round(((usageDeltaNs / timeDeltaNs) / allocatedCpus) * 100));
                }
            }
            this.previousCgroupCpu = { usageNs: cgroupUsageNs, timestamp: now };
        } else {
            // Bare metal / dev: no cgroup limits, host-wide load is correct.
            this.previousCgroupCpu = null;
            usagePercent = Math.round(currentLoad.currentLoad || 0);
        }

        return {
            usagePercent,
            loadAverage: currentLoad.avgLoad ? [currentLoad.avgLoad] : [0, 0, 0],
            temperature: cpuTemperature.main,
            info: this.cpuInfo || undefined
        };
    }

    /**
     * Total CPU time consumed by this container's cgroup, in nanoseconds.
     * Returns null when no cgroup CPU counter is readable (bare metal).
     */
    private async readCgroupCpuUsageNs(): Promise<number | null> {
        // cgroup v2: /sys/fs/cgroup/cpu.stat contains "usage_usec <n>".
        try {
            const stat = await fs.promises.readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
            const match = stat.match(/^usage_usec (\d+)$/m);
            if (match) {
                return Number(match[1]) * 1000;
            }
        } catch {
            // not cgroup v2
        }
        // cgroup v1: cpuacct.usage is already in nanoseconds.
        try {
            const raw = await fs.promises.readFile('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8');
            const ns = Number(raw.trim());
            if (Number.isFinite(ns)) {
                return ns;
            }
        } catch {
            // not cgroup v1
        }
        return null;
    }

    /**
     * Number of CPUs allocated to this container (cgroup quota, else cpuset).
     * Returns null when the container has no CPU restriction visible, in
     * which case host-wide metrics are the meaningful fallback.
     */
    private async getAllocatedCpuCount(): Promise<number | null> {
        // cgroup v2: /sys/fs/cgroup/cpu.max is "<quota|max> <period>".
        try {
            const content = (await fs.promises.readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim();
            const [quota, period] = content.split(/\s+/);
            if (quota && quota !== 'max') {
                const q = Number(quota);
                const p = Number(period);
                if (q > 0 && p > 0) {
                    return q / p;
                }
            }
        } catch {
            // not cgroup v2
        }
        // cgroup v1: cpu.cfs_quota_us / cpu.cfs_period_us.
        try {
            const [quotaRaw, periodRaw] = await Promise.all([
                fs.promises.readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'),
                fs.promises.readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8')
            ]);
            const q = Number(quotaRaw.trim());
            const p = Number(periodRaw.trim());
            if (q > 0 && p > 0) {
                return q / p;
            }
        } catch {
            // no v1 quota
        }
        // No bandwidth quota: fall back to the cpuset (v2 then v1).
        for (const path of ['/sys/fs/cgroup/cpuset.cpus.effective', '/sys/fs/cgroup/cpuset/cpuset.cpus']) {
            try {
                const cpus = (await fs.promises.readFile(path, 'utf8')).trim();
                if (cpus) {
                    return this.countCpusInList(cpus);
                }
            } catch {
                // try next
            }
        }
        return null;
    }

    /** Count entries in a cpuset list like "0-3,8,10-11". */
    private countCpusInList(list: string): number {
        let count = 0;
        for (const part of list.split(',')) {
            const range = part.split('-').map(Number);
            if (range.length === 2 && range[1] >= range[0]) {
                count += range[1] - range[0] + 1;
            } else if (range.length === 1 && Number.isFinite(range[0])) {
                count += 1;
            }
        }
        return count > 0 ? count : os.cpus().length;
    }

    private async getMemoryMetrics(): Promise<MemoryMetrics> {
        const mem = await si.mem();

        const usedMemory = mem.total - mem.available;
        const usagePercent = mem.total > 0 ? Math.round((usedMemory / mem.total) * 100) : 0;

        const result: MemoryMetrics = {
            total: mem.total,
            used: usedMemory,
            free: mem.available,
            usagePercent
        };

        // Add swap info if available
        if (mem.swaptotal > 0) {
            result.swapTotal = mem.swaptotal;
            result.swapUsed = mem.swapused;
            result.swapFree = mem.swapfree;
            result.swapPercent = Math.round((mem.swapused / mem.swaptotal) * 100);
        }

        return result;
    }

    private async getDiskMetrics(): Promise<DiskMetrics> {
        try {
            const fsSize = await si.fsSize();

            // Pseudo/ephemeral filesystems that are never useful disk entries
            // (container tmpfs mounts, CD-ROMs, loop-mounted squashfs images).
            const excludedFsTypes = new Set(['tmpfs', 'devtmpfs', 'ramfs', 'squashfs', 'iso9660']);

            // Store all real filesystems for selection: any non-pseudo mount
            // of at least 1 GiB — this covers container roots (overlay) as
            // well as separately mounted volumes (e.g. /home/<user> on LVM).
            this.allDisks = fsSize
                .filter((fs) => fs.size >= 1024 * 1024 * 1024 && !excludedFsTypes.has((fs.type || '').toLowerCase()))
                .map((fs) => ({
                    fs: fs.fs,
                    type: fs.type,
                    size: fs.size,
                    used: fs.used,
                    available: fs.available,
                    use: fs.use,
                    mount: fs.mount
                }))
                .sort((a, b) => b.size - a.size);

            // Use selected disk or default to largest
            const mainFs = this.allDisks[this.selectedDiskIndex] ||
                this.allDisks[0] || { size: 0, used: 0, available: 0, use: 0, fs: '', mount: '' };

            return {
                total: mainFs.size,
                used: mainFs.used,
                free: mainFs.available,
                usagePercent: Math.round(mainFs.use || 0)
            };
        } catch (error) {
            console.error('[Sysmon] Disk metrics error:', error);
            return { total: 0, used: 0, free: 0, usagePercent: 0 };
        }
    }

    private async getNetworkMetrics(): Promise<NetworkMetrics> {
        const networkStats = await si.networkStats();

        const activeInterface = networkStats
            .filter((n) => n.iface && !n.iface.includes('lo'))
            .sort((a, b) => b.rx_bytes + b.tx_bytes - (a.rx_bytes + a.tx_bytes))[0] || { rx_bytes: 0, tx_bytes: 0, iface: 'unknown' };

        const now = Date.now();
        let downloadSpeed = 0;
        let uploadSpeed = 0;

        if (this.previousNetworkStats && this.previousNetworkStats.iface === activeInterface.iface) {
            const timeDiff = (now - this.previousNetworkStats.timestamp) / 1000;
            if (timeDiff > 0) {
                downloadSpeed = Math.max(0, (activeInterface.rx_bytes - this.previousNetworkStats.bytesReceived) / timeDiff);
                uploadSpeed = Math.max(0, (activeInterface.tx_bytes - this.previousNetworkStats.bytesSent) / timeDiff);
            }
        }

        this.previousNetworkStats = {
            bytesReceived: activeInterface.rx_bytes,
            bytesSent: activeInterface.tx_bytes,
            timestamp: now,
            iface: activeInterface.iface
        };

        return {
            bytesReceived: activeInterface.rx_bytes,
            bytesSent: activeInterface.tx_bytes,
            downloadSpeed,
            uploadSpeed,
            interfaceName: activeInterface.iface
        };
    }
}
