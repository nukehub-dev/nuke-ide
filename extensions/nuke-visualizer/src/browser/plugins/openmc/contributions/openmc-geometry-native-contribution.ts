// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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

import { injectable, inject } from '@theia/core/shared/inversify';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { OutputViewerContribution } from '../../../output-viewer/output-viewer-registry';
import { OpenMCBackendService } from '../../../../common/openmc-protocol';
import { OpenMCGeometryContribution } from './openmc-geometry-contribution';
import { GeometryNativeViewerWidget } from '../widgets/geometry-native/geometry-native-viewer-widget';

/**
 * Routes OpenMC `geometry.xml` files to the geometry hierarchy tree plus the
 * native geometry viewer via the OutputViewerRegistry: the tree opens exactly
 * as before (`OpenMCGeometryContribution.openGeometryHierarchy`), then
 * `openmc.geometry-mesh` extracts the CSG cells to a mesh JSON file that
 * loads into `GeometryNativeViewerWidget.setModelFile` — no server.
 *
 * Additive, no replacement: the tree and its hierarchy view are untouched.
 * When the mesh extraction fails the tree stays open and the error names
 * the cause.
 */
@injectable()
export class OpenMCGeometryNativeViewerContribution implements OutputViewerContribution {
    readonly id = 'openmc-geometry-native-viewer';
    readonly label = 'OpenMC Native Geometry Viewer';
    readonly priority = 100;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    @inject(OpenMCGeometryContribution)
    protected readonly geometry!: OpenMCGeometryContribution;

    canHandle(uri: URI): number {
        return uri.path.base.toLowerCase() === 'geometry.xml' ? 600 : 0;
    }

    async open(uri: URI): Promise<void> {
        // Existing behavior first: hierarchy tree (and its trame-3D view).
        await this.geometry.openGeometryHierarchy(uri);

        let mesh;
        try {
            mesh = await this.openmcBackend.extractGeometryMesh(uri.path.toString());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[geometry-native] openmc.geometry-mesh failed for ${uri.path.toString()}: ${message}`);
            this.messageService.error(`Native geometry view failed: ${message}.`);
            return;
        }
        if (!mesh.success || !mesh.meshPath) {
            const message = mesh.error || 'Mesh extraction failed';
            console.warn(`[geometry-native] openmc.geometry-mesh failed for ${uri.path.toString()}: ${message}`);
            this.messageService.error(`Native geometry view failed: ${message}.`);
            return;
        }

        const widget = await this.widgetManager.getOrCreateWidget<GeometryNativeViewerWidget>(GeometryNativeViewerWidget.ID, {
            id: `${GeometryNativeViewerWidget.ID}:${uri.path.toString()}`
        });
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
        await widget.setModelFile(new URI(mesh.meshPath));
    }
}
