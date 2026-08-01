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

/**
 * Pure helper for the output viewers' missing-dependency guidance: extract
 * which Python packages a backend error is about, so the widgets can render
 * an actionable install/switch-environment panel instead of a bare error.
 * No DI/DOM dependencies — unit-testable in node.
 */

/** Known Python dependencies the output viewers rely on, matched from backend error text */
const DEPENDENCY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/vtk/i, 'vtk'],
    [/h5py/i, 'h5py'],
    [/trame/i, 'trame'],
    [/paraview/i, 'paraview'],
    [/openmc/i, 'openmc']
];

/**
 * Extract missing Python dependencies from a backend error message, or
 * undefined when the error is not dependency-related. Matches the messages
 * the python commands raise ("vtk not installed", "No module named 'trame'",
 * "Required dependencies not installed: ...") and the node-side environment
 * detection failure ("Failed to detect Python environment with ...").
 */
export function detectMissingDependencies(error: string): string[] | undefined {
    if (!/not installed|no module named|required dependencies|not available|failed to detect python/i.test(error)) {
        return undefined;
    }
    const deps = DEPENDENCY_PATTERNS.filter(([pattern]) => pattern.test(error)).map(([, name]) => name);
    return [...new Set(deps)];
}
