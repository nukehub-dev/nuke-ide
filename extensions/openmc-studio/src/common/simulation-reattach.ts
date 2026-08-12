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
 * Matching logic for re-attaching a frontend to an in-flight backend
 * simulation after a tab reload / reconnect.
 *
 * @module openmc-studio/common
 */

import { ActiveSimulationInfo } from './openmc-studio-protocol';

/**
 * Pick which active backend run a frontend should re-attach to.
 *
 * Prefers the run started from the given working directory. When no directory
 * matches but the backend has exactly one active run, that run is returned
 * (the run may have used a custom working directory, and a single backend can
 * only be driving one meaningful run for this window's purposes). Ambiguous
 * multi-run cases return `undefined` rather than guessing.
 *
 * @param active - Runs currently active in the backend.
 * @param workingDirectory - Project directory of the calling frontend.
 * @returns The run to attach to, or `undefined` when no safe match exists.
 */
export function pickReattachTarget(active: ActiveSimulationInfo[], workingDirectory: string): ActiveSimulationInfo | undefined {
    return active.find((sim) => sim.workingDirectory === workingDirectory) ?? (active.length === 1 ? active[0] : undefined);
}
