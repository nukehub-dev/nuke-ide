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
 * Shared OpenMC package metadata.
 *
 * Single source of truth for package requirements used by health checks,
 * installation, and environment validation.
 *
 * @see {@link OpenMCHealthService} for health check consumption
 * @see {@link OpenMCInstallerService} for installation consumption
 * @see {@link OPENMC_EXTRA_INDEX_URL} for the pip extra index URL
 * @module openmc-studio/browser/services
 */

import { PackageDependency } from 'nuke-core/lib/common';
import { OPENMC_EXTRA_INDEX_URL } from './openmc-environment-service';

/**
 * Get the canonical OpenMC package dependencies for health checks.
 * Nuke-core uses this metadata to generate install suggestions automatically.
 * @returns Array of {@link PackageDependency} objects describing required and optional packages.
 */
export function getOpenMCHealthPackages(): PackageDependency[] {
    return [
        { name: 'h5py', required: true },
        { name: 'openmc', required: true, extraIndexUrl: OPENMC_EXTRA_INDEX_URL },
        { name: 'numpy', required: true },
        { name: 'mpi4py', required: false },
        { name: 'pydagmc', required: false, installCommand: 'pip install git+https://github.com/svalinn/pydagmc' },
        { name: 'moab', required: false, extraIndexUrl: OPENMC_EXTRA_INDEX_URL },
        { name: 'OCP', required: false }
    ];
}
