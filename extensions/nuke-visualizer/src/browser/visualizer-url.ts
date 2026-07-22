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

import { Endpoint } from '@theia/core/lib/browser/endpoint';

/**
 * Convert a loopback visualizer server URL (`http://127.0.0.1:<port>`) into a
 * URL routed through the Theia backend's visualizer reverse proxy
 * (`/visualizer/<port>/`).
 *
 * Required for deployments where the IDE backend does not share a host with
 * the browser (e.g. NukeLab containers behind nginx): the loopback port is
 * only reachable from the backend, never from the user's browser.
 *
 * URLs that are not loopback URLs are returned unchanged.
 */
export function toProxiedVisualizerUrl(serverUrl: string): string {
    const match = serverUrl.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?):(\d+)/);
    if (!match) {
        return serverUrl;
    }
    return new Endpoint({ path: `/visualizer/${match[1]}/` }).getRestUrl().toString();
}
