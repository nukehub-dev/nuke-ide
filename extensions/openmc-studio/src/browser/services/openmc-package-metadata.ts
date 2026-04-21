// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0
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
        { name: 'moab', required: false, extraIndexUrl: OPENMC_EXTRA_INDEX_URL }
    ];
}
