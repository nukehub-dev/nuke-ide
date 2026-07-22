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

/**
 * Visualizer Reverse Proxy
 *
 * Proxies HTTP and WebSocket traffic from `/visualizer/<port>/*` on the Theia
 * backend to the trame servers the visualizer spawns on `127.0.0.1:<port>`.
 *
 * Without this, widget iframes point at `http://127.0.0.1:<port>` directly,
 * which only works when browser and IDE share a host — behind the NukeLab
 * nginx deployment the port is unreachable from the user's browser. trame is
 * path-prefix friendly (relative asset paths, ws URL derived from the page
 * directory), so no response rewriting is needed.
 *
 * Forwarding is restricted to ports owned by the visualizer backend services
 * so the proxy cannot be used to reach arbitrary localhost services.
 *
 * @module nuke-visualizer/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as express from 'express';
import httpProxy = require('http-proxy');
import { VisualizerBackendServiceImpl } from './visualizer-backend-service';
import { OpenMCBackendServiceImpl } from './plugins/openmc/openmc-backend-service';

@injectable()
export class VisualizerProxyContribution implements BackendApplicationContribution {
    @inject(VisualizerBackendServiceImpl)
    protected readonly visualizerService: VisualizerBackendServiceImpl;

    @inject(OpenMCBackendServiceImpl)
    protected readonly openmcService: OpenMCBackendServiceImpl;

    protected readonly proxy = httpProxy.createProxyServer({ ws: true });

    constructor() {
        this.proxy.on('error', (err, _req, resOrSocket) => {
            console.error(`[VisualizerProxy] ${err.message}`);
            if (resOrSocket instanceof http.ServerResponse) {
                if (!resOrSocket.headersSent) {
                    resOrSocket.writeHead(502, { 'Content-Type': 'text/plain' });
                }
                resOrSocket.end('Visualizer server unreachable');
            } else {
                // WebSocket upgrade failure — no HTTP response possible
                (resOrSocket as net.Socket).destroy();
            }
        });
    }

    /** Allow forwarding only to ports owned by a visualizer backend service. */
    protected isAllowedPort(port: number): boolean {
        return this.visualizerService.isVisualizerPort(port) || this.openmcService.isVisualizerPort(port);
    }

    /**
     * Strip the `/visualizer/<port>` prefix from a request URL.
     * Returns the port and the remaining path, or undefined when the URL
     * does not target the visualizer proxy.
     */
    protected parseProxyUrl(url: string | undefined, prefix: string): { port: number; path: string } | undefined {
        if (!url || !url.startsWith(prefix)) {
            return undefined;
        }
        const rest = url.substring(prefix.length);
        const match = rest.match(/^(\d+)([/?].*)?$/);
        if (!match) {
            return undefined;
        }
        return { port: parseInt(match[1], 10), path: match[2] || '/' };
    }

    configure(app: express.Application): void {
        app.use('/visualizer', (req, res) => {
            const target = this.parseProxyUrl(req.url, '/');
            if (!target || !this.isAllowedPort(target.port)) {
                res.status(403).send('Not a visualizer server port');
                return;
            }
            req.url = target.path;
            this.proxy.web(req, res, { target: `http://127.0.0.1:${target.port}` });
        });
    }

    onStart(server: http.Server | https.Server): void {
        // Handle WebSocket upgrades for trame's /ws endpoint. Requests that do
        // not target the visualizer proxy are left untouched for Theia's
        // socket.io handler on the same HTTP server.
        server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
            const target = this.parseProxyUrl(req.url, '/visualizer/');
            if (!target) {
                return;
            }
            if (!this.isAllowedPort(target.port)) {
                socket.destroy();
                return;
            }
            req.url = target.path;
            this.proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${target.port}` });
        });
    }
}
