// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
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

    async initialize(): Promise<void> {
        // Collect static system info once
        const [osInfo, cpuData, processes] = await Promise.all([
            si.osInfo(),
            si.cpu(),
            si.processes().catch(() => ({ all: 0 }))
        ]);

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
            timestamps: data.map(m => m.timestamp),
            cpu: data.map(m => m.cpu.usagePercent),
            memory: data.map(m => m.memory.usagePercent),
            networkDownload: data.map(m => m.network.downloadSpeed),
            networkUpload: data.map(m => m.network.uploadSpeed)
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

            this.callbacks.forEach(cb => {
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
        const [currentLoad, cpuTemperature] = await Promise.all([
            si.currentLoad(),
            si.cpuTemperature().catch(() => ({ main: undefined })) as Promise<{ main?: number }>
        ]);

        return {
            usagePercent: Math.round(currentLoad.currentLoad || 0),
            loadAverage: currentLoad.avgLoad ? [currentLoad.avgLoad] : [0, 0, 0],
            temperature: cpuTemperature.main,
            info: this.cpuInfo || undefined
        };
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
            
            // Store all physical disks for selection
            this.allDisks = fsSize
                .filter(fs => fs.size > 10 * 1024 * 1024 * 1024) // > 10GB
                .map(fs => ({
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
            const mainFs = this.allDisks[this.selectedDiskIndex] || this.allDisks[0] || 
                          { size: 0, used: 0, available: 0, use: 0, fs: '', mount: '' };

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
            .filter(n => n.iface && !n.iface.includes('lo'))
            .sort((a, b) => (b.rx_bytes + b.tx_bytes) - (a.rx_bytes + a.tx_bytes))[0] 
            || { rx_bytes: 0, tx_bytes: 0, iface: 'unknown' };

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
