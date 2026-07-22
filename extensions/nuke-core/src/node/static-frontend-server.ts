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
 * Static Frontend Server
 *
 * Custom {@link BackendApplicationServer} that replaces Theia's default
 * `express.static` mount for the built frontend. Theia's webpack build does
 * not content-hash its JS output (`bundle.js` and lazy chunks keep stable
 * names across builds), so a cached HTML shell or bundle can reference stale
 * code after a redeploy and the browser has no URL-level signal that anything
 * changed.
 *
 * The HTML shell is tiny, so it is served with `Cache-Control: no-store`:
 * every navigation fetches it fresh, and `no-store` pages are excluded from
 * the browser's back/forward cache, which would otherwise resurrect a stale
 * shell without revalidation. The heavy JS/CSS bundles keep express's default
 * ETag revalidation (`max-age=0`): every load revalidates each asset, but
 * unchanged ones come back as cheap 304s instead of full downloads — the
 * browser-native equivalent of a cache version check.
 *
 * @module nuke-core/node
 */

import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationServer, BackendApplicationPath } from '@theia/core/lib/node';
import * as express from '@theia/core/shared/express';
import * as path from 'path';

@injectable()
export class StaticFrontendServer implements BackendApplicationServer {
    configure(app: express.Application): void {
        const frontendPath = path.join(BackendApplicationPath, 'lib', 'frontend');
        app.use(
            express.static(frontendPath, {
                setHeaders: (res, filePath) => {
                    if (filePath.endsWith('.html')) {
                        res.setHeader('Cache-Control', 'no-store');
                    }
                }
            })
        );
    }
}
