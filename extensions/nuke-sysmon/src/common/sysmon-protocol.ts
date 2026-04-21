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
