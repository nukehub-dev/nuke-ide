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
 * Canonical depletion solver (integrator) list, shared by the depletion tab,
 * the settings.xml depletion block, the runner, and the Python exporter.
 * Ids are the OpenMC short names from `openmc/deplete/integrators.py`
 * `integrator_by_name` (lines 565-574, identical in 0.15.3 and the dev
 * clone). The Python driver `run_depletion.py` mirrors this module.
 *
 * @module openmc-studio/common
 */

/** One depletion integrator. */
export interface DepletionSolver {
    /** OpenMC short name (`integrator_by_name` key) */
    id: DepletionSolverId;
    /** `openmc.deplete` integrator class name */
    className: string;
    /** Friendly UI label */
    label: string;
}

export type DepletionSolverId = 'cecm' | 'predictor' | 'cf4' | 'celi' | 'epc_rk4' | 'leqi' | 'si_celi' | 'si_leqi';

/** The 8 real OpenMC integrators, in UI display order. */
export const DEPLETION_SOLVERS: DepletionSolver[] = [
    { id: 'cecm', className: 'CECMIntegrator', label: 'CE/CM (default)' },
    { id: 'predictor', className: 'PredictorIntegrator', label: 'Predictor' },
    { id: 'cf4', className: 'CF4Integrator', label: 'CF4' },
    { id: 'celi', className: 'CELIIntegrator', label: 'CE/LI' },
    { id: 'epc_rk4', className: 'EPCRK4Integrator', label: 'EPC-RK4' },
    { id: 'leqi', className: 'LEQIIntegrator', label: 'LE/QI' },
    { id: 'si_celi', className: 'SICELIIntegrator', label: 'SI-CE/LI (Stochastic Implicit)' },
    { id: 'si_leqi', className: 'SILEQIIntegrator', label: 'SI-LE/QI (Stochastic Implicit)' }
];

/**
 * Legacy solver names accepted on read (never emitted). Covers the pre-fix
 * UI values and the pre-fix driver ids.
 */
export const DEPLETION_SOLVER_ALIASES: Record<string, DepletionSolverId> = {
    // Pre-fix UI values
    leapfrog: 'leqi',
    'predictor-corrector': 'predictor',
    'si-rk4': 'si_celi',
    'ce-cm': 'cecm',
    // Pre-fix driver ids
    epc: 'epc_rk4',
    cecmr: 'cecm',
    epcr: 'epc_rk4',
    'si-cesc': 'si_celi'
};

/**
 * Resolve a stored solver value to a canonical id, mapping legacy aliases.
 * Unknown values fall back to `cecm` (the OpenMC default integrator).
 * @param value - Stored solver value (canonical, legacy, or undefined).
 * @returns Canonical solver id.
 */
export function resolveDepletionSolver(value: string | undefined): DepletionSolverId {
    if (!value) {
        return 'cecm';
    }
    const v = value.toLowerCase();
    if ((DEPLETION_SOLVERS as DepletionSolver[]).some((s) => s.id === v)) {
        return v as DepletionSolverId;
    }
    return DEPLETION_SOLVER_ALIASES[v] ?? 'cecm';
}

/**
 * Look up a solver entry by id (after {@link resolveDepletionSolver}).
 * @param id - Canonical solver id.
 * @returns The solver entry.
 */
export function getDepletionSolver(id: DepletionSolverId): DepletionSolver {
    return DEPLETION_SOLVERS.find((s) => s.id === id)!;
}
