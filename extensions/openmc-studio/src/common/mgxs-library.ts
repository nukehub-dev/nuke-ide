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
 * MGXS library path resolution shared by the XML generator, the simulation
 * runner, and the random ray tab. Unifies the canonical
 * `settings.mgxsLibrary` with the legacy `settings.randomRay.mgxsLibraryPath`
 * (pre-1.1.0 projects).
 *
 * @module openmc-studio/common
 */

import { OpenMCSettings } from './openmc-state-schema';

/**
 * Resolve the configured MGXS library path RAW, or undefined when no library
 * is configured. Resolution order: canonical `settings.mgxsLibrary`, then
 * legacy `settings.randomRay.mgxsLibraryPath`. The value may name the
 * `mgxs.h5` file itself (with or without extension) or a directory holding
 * it — file-level resolution is fs-aware at the call sites (the XML
 * generator and the simulation runner each stat the path).
 *
 * @param settings - Simulation settings.
 * @returns The configured library path as-is.
 */
export function resolveMgxsLibrary(settings: OpenMCSettings): string | undefined {
    return settings.mgxsLibrary || settings.randomRay?.mgxsLibraryPath || undefined;
}
