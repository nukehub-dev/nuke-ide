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
 * OpenMC Studio Package Requirements
 *
 * Single source of truth for Python package dependencies, consumed by health
 * checks, installation, and environment validation across the extension.
 * The package lists live in `./packages.json`; never inline them elsewhere.
 *
 * @module openmc-studio/common
 * @see {@link ./packages.json} for the underlying package definitions
 */

import { PackageDependency } from 'nuke-core/lib/common';

import * as packages from './packages.json';

/** Shared extra index URL hosting the OpenMC and moab wheels (not on PyPI). */
export const OPENMC_EXTRA_INDEX_URL = 'https://shimwell.github.io/wheels';

/** Core packages required to run OpenMC simulations. */
export const STUDIO_CORE_PACKAGES: PackageDependency[] = packages.core;

/** DAGMC geometry toolchain. The `pydagmc` installCommand must stay pinned. */
export const DAGMC_PACKAGES: PackageDependency[] = packages.dagmc;

/** CAD import libraries (gmsh, OpenCASCADE via `OCC`, CadQuery). */
export const CAD_PACKAGES: PackageDependency[] = packages.cad;

/** Full package set verified by the OpenMC health check. */
export const OPENMC_HEALTH_PACKAGES: PackageDependency[] = packages.health;
