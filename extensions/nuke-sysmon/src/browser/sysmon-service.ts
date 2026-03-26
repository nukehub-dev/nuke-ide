// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging';
import { Emitter, Event } from '@theia/core/lib/common';
import {
    SysmonService,
    SYSMON_BACKEND_PATH,
    SystemMetrics,
    HistoricalData,
    DiskInfo
} from '../common/sysmon-protocol';

@injectable()
export class SysmonFrontendService implements SysmonService {
    private readonly onMetricsUpdatedEmitter = new Emitter<SystemMetrics>();
    readonly onMetricsUpdatedEvent: Event<SystemMetrics> = this.onMetricsUpdatedEmitter.event;

    private proxy: SysmonService;

    @inject(WebSocketConnectionProvider)
    protected readonly connectionProvider: WebSocketConnectionProvider;

    @postConstruct()
    protected init(): void {
        this.proxy = this.connectionProvider.createProxy<SysmonService>(SYSMON_BACKEND_PATH);
    }

    async getCurrentMetrics(): Promise<SystemMetrics> {
        return this.proxy.getCurrentMetrics();
    }

    async getHistoricalData(points?: number): Promise<HistoricalData> {
        return this.proxy.getHistoricalData(points);
    }

    async getAllDisks(): Promise<DiskInfo[]> {
        return this.proxy.getAllDisks();
    }

    async setSelectedDisk(index: number): Promise<void> {
        return this.proxy.setSelectedDisk(index);
    }

    onMetricsUpdated(callback: (metrics: SystemMetrics) => void): void {
        this.onMetricsUpdatedEmitter.event(callback);
    }

    notifyMetricsUpdated(metrics: SystemMetrics): void {
        this.onMetricsUpdatedEmitter.fire(metrics);
    }
}
