// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

export const SYSMON_BACKEND_PATH = '/services/sysmon';
export const SYSMON_SERVICE = Symbol('SysmonService');

export interface SystemMetrics {
    timestamp: number;
    cpu: CpuMetrics;
    memory: MemoryMetrics;
    disk: DiskMetrics;
    network: NetworkMetrics;
    system: SystemInfo;
}

export interface CpuMetrics {
    usagePercent: number;
    loadAverage: number[];
    temperature?: number;
    info?: CpuInfo;
}

export interface CpuInfo {
    manufacturer: string;
    brand: string;
    speed: number;
    cores: number;
    physicalCores: number;
}

export interface MemoryMetrics {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
    swapTotal?: number;
    swapUsed?: number;
    swapFree?: number;
    swapPercent?: number;
}

export interface DiskMetrics {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
    readSpeed?: number;
    writeSpeed?: number;
}

export interface NetworkMetrics {
    bytesReceived: number;
    bytesSent: number;
    downloadSpeed: number;
    uploadSpeed: number;
    interfaceName?: string;
}

export interface SystemInfo {
    hostname: string;
    platform: string;
    distro: string;
    release: string;
    arch: string;
    uptime: number;
    processCount?: number;
}

export interface HistoricalData {
    timestamps: number[];
    cpu: number[];
    memory: number[];
    networkDownload: number[];
    networkUpload: number[];
}

export const SysmonService = Symbol('SysmonService');

export interface DiskInfo {
    fs: string;
    type: string;
    size: number;
    used: number;
    available: number;
    use: number;
    mount: string;
}

export interface SysmonService {
    getCurrentMetrics(): Promise<SystemMetrics>;
    getHistoricalData(points?: number): Promise<HistoricalData>;
    getAllDisks(): Promise<DiskInfo[]>;
    setSelectedDisk(index: number): Promise<void>;
    onMetricsUpdated(callback: (metrics: SystemMetrics) => void): void;
}
