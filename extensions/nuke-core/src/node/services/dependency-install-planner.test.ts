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
 * Tests for {@link buildDependencyInstallPlan}: conda/venv routing, conda
 * batching with channel union, pip grouping by (`extraIndexUrl`, `pipArgs`)
 * signature, and non-installable (condaOnly in a venv) reporting.
 */

import { describe, expect, it } from 'vitest';
import { PackageDependency } from '../../common/nuke-core-protocol';
import { buildDependencyInstallPlan } from './dependency-install-planner';

const SHIMWELL = 'https://shimwell.github.io/wheels';
const PYDAGMC_GIT = 'git+https://github.com/svalinn/pydagmc@4afa678d24aa091417798ef4b3d11fda98b165f8';

const openmc: PackageDependency = { name: 'openmc', extraIndexUrl: SHIMWELL };
const paraview: PackageDependency = { name: 'paraview', condaOnly: true, condaSpec: 'paraview' };
const gmsh: PackageDependency = { name: 'gmsh', condaSpec: 'python-gmsh' };
const ocp: PackageDependency = { name: 'OCP', condaSpec: 'ocp', pipSpec: 'cadquery-ocp' };
const build123d: PackageDependency = { name: 'build123d', pipSpec: 'build123d==0.9.1', pipArgs: ['--no-deps'] };
const pydagmc: PackageDependency = { name: 'pydagmc', pipSpec: PYDAGMC_GIT };
const numpy: PackageDependency = { name: 'numpy' };

describe('buildDependencyInstallPlan', () => {
    it('routes condaOnly and condaSpec entries to a single conda batch in conda envs', () => {
        const plan = buildDependencyInstallPlan([paraview, gmsh, ocp], true);
        expect(plan.conda).toEqual({ specs: ['paraview', 'python-gmsh', 'ocp'], channels: ['conda-forge'] });
        expect(plan.pip).toEqual([]);
        expect(plan.skipped).toEqual([]);
    });

    it('unions declared conda channels instead of defaulting to conda-forge', () => {
        const plan = buildDependencyInstallPlan(
            [
                { name: 'a', condaOnly: true, channels: ['conda-forge', 'custom'] },
                { name: 'b', condaSpec: 'b-spec', channels: ['custom'] }
            ],
            true
        );
        expect(plan.conda).toEqual({ specs: ['a', 'b-spec'], channels: ['conda-forge', 'custom'] });
    });

    it('keeps pip-only entries on pip in conda envs', () => {
        const plan = buildDependencyInstallPlan([openmc, pydagmc, paraview], true);
        expect(plan.conda).toEqual({ specs: ['paraview'], channels: ['conda-forge'] });
        expect(plan.pip).toEqual([
            { specs: ['openmc'], args: [], extraIndexUrl: SHIMWELL },
            { specs: [PYDAGMC_GIT], args: [], extraIndexUrl: undefined }
        ]);
        expect(plan.skipped).toEqual([]);
    });

    it('routes everything to pip in non-conda envs, using pipSpec in place of name', () => {
        const plan = buildDependencyInstallPlan([gmsh, ocp, numpy], false);
        expect(plan.conda).toBeUndefined();
        // Same (no-index, no-args) signature → one shared pip command
        expect(plan.pip).toEqual([{ specs: ['gmsh', 'cadquery-ocp', 'numpy'], args: [], extraIndexUrl: undefined }]);
        expect(plan.skipped).toEqual([]);
    });

    it('isolates pipArgs groups from plain installs', () => {
        const plan = buildDependencyInstallPlan([build123d, numpy], false);
        expect(plan.pip).toHaveLength(2);
        const noDeps = plan.pip.find((g) => g.args.includes('--no-deps'));
        const plain = plan.pip.find((g) => g.args.length === 0);
        expect(noDeps?.specs).toEqual(['build123d==0.9.1']);
        expect(plain?.specs).toEqual(['numpy']);
    });

    it('groups pip entries by identical extraIndexUrl signature', () => {
        const moab: PackageDependency = { name: 'moab', extraIndexUrl: SHIMWELL };
        const plan = buildDependencyInstallPlan([openmc, moab, numpy], false);
        expect(plan.pip).toEqual([
            { specs: ['openmc', 'moab'], args: [], extraIndexUrl: SHIMWELL },
            { specs: ['numpy'], args: [], extraIndexUrl: undefined }
        ]);
    });

    it('reports condaOnly entries in non-conda envs as skipped (hint-only)', () => {
        const plan = buildDependencyInstallPlan([paraview, numpy], false);
        expect(plan.conda).toBeUndefined();
        expect(plan.pip).toEqual([{ specs: ['numpy'], args: [], extraIndexUrl: undefined }]);
        expect(plan.skipped).toEqual([paraview]);
    });

    it('returns an empty plan for empty input', () => {
        const plan = buildDependencyInstallPlan([], true);
        expect(plan.conda).toBeUndefined();
        expect(plan.pip).toEqual([]);
        expect(plan.skipped).toEqual([]);
    });
});
