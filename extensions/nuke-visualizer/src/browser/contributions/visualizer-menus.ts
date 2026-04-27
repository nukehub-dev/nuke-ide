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

import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';

export namespace NukeVisualizerMenus {
    /** Root Visualizer menu under Tools */
    export const VISUALIZER = [...NukeMenus.TOOLS, '2_visualizer'];

    /** Environment submenu under Visualizer */
    export const ENVIRONMENT = [...VISUALIZER, 'z_environment'];

    /** OpenMC plugin submenu under Visualizer */
    export const OPENMC = [...VISUALIZER, '1_openmc'];

    // OpenMC sub-menus (kept for backward compatibility during migration)
    export const OPENMC_STATEPOINT = [...OPENMC, '1_statepoint'];
    export const OPENMC_TALLY = [...OPENMC, '2_tally'];
    export const OPENMC_DEPLETION = [...OPENMC, '3_depletion'];
    export const OPENMC_GEOMETRY = [...OPENMC, '4_geometry'];
    export const OPENMC_MATERIAL = [...OPENMC, '5_material'];
    export const OPENMC_PLOT = [...OPENMC, '6_plot'];

    // Deprecated aliases — will be removed in Phase 5
    /** @deprecated Use OPENMC_STATEPOINT */
    export const VISUALIZER_STATEPOINT = OPENMC_STATEPOINT;
    /** @deprecated Use OPENMC_TALLY */
    export const VISUALIZER_TALLY = OPENMC_TALLY;
    /** @deprecated Use OPENMC_DEPLETION */
    export const VISUALIZER_DEPLETION = OPENMC_DEPLETION;
    /** @deprecated Use OPENMC_GEOMETRY */
    export const VISUALIZER_GEOMETRY = OPENMC_GEOMETRY;
    /** @deprecated Use OPENMC_MATERIAL */
    export const VISUALIZER_MATERIAL = OPENMC_MATERIAL;
    /** @deprecated Use OPENMC_PLOT */
    export const VISUALIZER_PLOT = OPENMC_PLOT;
}
