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
