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
 * Command definitions for nuke-cad.
 *
 * @module nuke-cad/browser
 */

import { Command, nls } from '@theia/core/lib/common';

export namespace NukeCadCommands {
    export const OPEN_CAD_VIEWPORT: Command = {
        id: 'nuke.cad.openViewport',
        label: nls.localize('nuke/cad/openViewport', 'Open CAD Viewport')
    };

    export const REBUILD_GEOMETRY: Command = {
        id: 'nuke.cad.rebuild',
        label: nls.localize('nuke/cad/rebuild', 'Rebuild CAD Geometry')
    };

    export const CHECK_CAD_ENVIRONMENT: Command = {
        id: 'nuke.cad.checkEnvironment',
        label: nls.localize('nuke/cad/checkEnvironment', 'Check CAD Environment')
    };

    export const OPEN_OUTLINE_PANEL: Command = {
        id: 'nuke.cad.openOutlinePanel',
        label: nls.localize('nuke/cad/openOutlinePanel', 'Open Model Outline')
    };

    export const OPEN_FEM_PANEL: Command = {
        id: 'nuke.cad.openFemPanel',
        label: nls.localize('nuke/cad/openFemPanel', 'Open FEM Analysis Panel')
    };

    export const OPEN_FOAM_PANEL: Command = {
        id: 'nuke.cad.openFoamPanel',
        label: nls.localize('nuke/cad/openFoamPanel', 'Open OpenFOAM Case Panel')
    };

    export const NEW_SKETCH: Command = {
        id: 'nuke.cad.newSketch',
        label: nls.localize('nuke/cad/newSketch', 'New Sketch')
    };

    export const EXIT_SKETCH: Command = {
        id: 'nuke.cad.exitSketch',
        label: nls.localize('nuke/cad/exitSketch', 'Exit Sketch')
    };
}
