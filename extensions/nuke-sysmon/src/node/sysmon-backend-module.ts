// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { SysmonBackendService } from './sysmon-backend-service';
import { SYSMON_BACKEND_PATH, SysmonService } from '../common/sysmon-protocol';

export default new ContainerModule(bind => {
    bind(SysmonBackendService).toSelf().inSingletonScope();
    
    bind(SysmonService).toService(SysmonBackendService);
    
    bind(ConnectionHandler).toDynamicValue(ctx => {
        const service = ctx.container.get(SysmonBackendService);
        service.startMonitoring(2000);
        
        return new JsonRpcConnectionHandler(SYSMON_BACKEND_PATH, () => ({
            getCurrentMetrics: () => service.getCurrentMetrics(),
            getHistoricalData: (points?: number) => service.getHistoricalData(points),
            getAllDisks: () => service.getAllDisks(),
            setSelectedDisk: (index: number) => { service.setSelectedDisk(index); return Promise.resolve(); },
            onMetricsUpdated: (callback: any) => service.onMetricsUpdated(callback)
        }));
    }).inSingletonScope();
});
