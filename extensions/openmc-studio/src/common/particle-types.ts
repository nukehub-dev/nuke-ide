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
 * Shared OpenMC particle-type model.
 *
 * OpenMC 0.16 replaced the `ParticleType` `IntEnum` with a class backed by the
 * PDG Monte Carlo numbering scheme (`openmc/particle_type.py`). The IDE stores
 * the canonical OpenMC name (the value `str(ParticleType)` returns) plus the
 * PDG number so the same model drives XML, Python, import, and the UI.
 *
 * @module openmc-studio/common
 */

import type { OpenMCCompat } from './openmc-studio-protocol';

/** A particle type in OpenMC's canonical name + optional PDG form. */
export interface OpenMCParticleType {
    /** Canonical name, e.g. `neutron`, `photon`, `electron`, `H1`, `He4`, `pdg:12345`. */
    name: string;
    /** PDG Monte Carlo particle number when known. */
    pdg?: number;
}

/**
 * Particle names accepted by pre-PDG project files (OpenMC 0.15.3's source
 * particle set). Read compatibility only: project load normalizes them to
 * {@link OpenMCParticleType}, and the UI always writes the shared form.
 */
export type OpenMCLegacyParticleName = 'neutron' | 'photon' | 'electron' | 'positron';

/** Stored particle value: canonical model or a legacy name. */
export type OpenMCParticleValue = OpenMCParticleType | OpenMCLegacyParticleName;

/** Where a particle type is being selected; determines OpenMC's supported set. */
export type OpenMCParticleScope = 'source' | 'tally-filter' | 'particle-production' | 'weight-window';

/** One preset offered by the particle selector. */
export interface OpenMCParticlePreset {
    /** Canonical OpenMC name (the value stored in state). */
    name: string;
    /** PDG Monte Carlo particle number. */
    pdg: number;
    /** Product label shown in the UI. */
    label: string;
    /** One-line explanation for the tooltip. */
    description: string;
}

/**
 * Common presets. Canonical names follow `str(openmc.ParticleType(...))`:
 * proton/deuteron/triton aliases resolve to `H1`/`H2`/`H3`, alpha to `He4`.
 */
export const OPENMC_PARTICLE_PRESETS: readonly OpenMCParticlePreset[] = [
    { name: 'neutron', pdg: 2112, label: 'Neutron', description: 'Neutron transport (the OpenMC default source particle)' },
    { name: 'photon', pdg: 22, label: 'Photon', description: 'Photon transport; enable photon transport in the run settings' },
    { name: 'electron', pdg: 11, label: 'Electron', description: 'Electron transport; available since OpenMC 0.15' },
    { name: 'positron', pdg: -11, label: 'Positron', description: 'Positron transport; available since OpenMC 0.15' },
    { name: 'H1', pdg: 2212, label: 'Proton (H1)', description: 'Proton source or filter bin (OpenMC canonical name H1)' },
    { name: 'H2', pdg: 1000010020, label: 'Deuteron (H2)', description: 'Deuteron (OpenMC canonical name H2)' },
    { name: 'H3', pdg: 1000010030, label: 'Triton (H3)', description: 'Triton (OpenMC canonical name H3)' },
    { name: 'He4', pdg: 1000020040, label: 'Alpha (He4)', description: 'Alpha particle (OpenMC canonical name He4)' },
    { name: 'He3', pdg: 1000020030, label: 'Helium-3 (He3)', description: 'Helium-3 ion (OpenMC canonical name He3)' }
];

/** Canonical neutron particle. */
export const NEUTRON_PARTICLE: OpenMCParticleType = { name: 'neutron', pdg: 2112 };

/** Canonical photon particle. */
export const PHOTON_PARTICLE: OpenMCParticleType = { name: 'photon', pdg: 22 };

/** Particle names accepted by every supported OpenMC release (0.15.3+). */
const BASE_PARTICLE_NAMES = new Set(['neutron', 'photon', 'electron', 'positron']);

/** Names accepted by OpenMC weight windows (the setter rejects everything else). */
const WEIGHT_WINDOW_PARTICLE_NAMES = new Set(['neutron', 'photon']);

/** OpenMC `ParticleType` aliases (`_ALIAS_PDG` in openmc/particle_type.py). */
const PARTICLE_ALIASES: Record<string, number> = {
    neutron: 2112,
    n: 2112,
    photon: 22,
    gamma: 22,
    electron: 11,
    positron: -11,
    proton: 2212,
    p: 2212,
    h1: 2212,
    deuteron: 1000010020,
    d: 1000010020,
    h2: 1000010020,
    triton: 1000010030,
    t: 1000010030,
    h3: 1000010030,
    alpha: 1000020040,
    he4: 1000020040,
    he3: 1000020030
};

/** Atomic symbols by atomic number, matching `openmc.data.ATOMIC_SYMBOL`. */
const ATOMIC_SYMBOLS: readonly string[] = [
    'H',
    'He',
    'Li',
    'Be',
    'B',
    'C',
    'N',
    'O',
    'F',
    'Ne',
    'Na',
    'Mg',
    'Al',
    'Si',
    'P',
    'S',
    'Cl',
    'Ar',
    'K',
    'Ca',
    'Sc',
    'Ti',
    'V',
    'Cr',
    'Mn',
    'Fe',
    'Co',
    'Ni',
    'Cu',
    'Zn',
    'Ga',
    'Ge',
    'As',
    'Se',
    'Br',
    'Kr',
    'Rb',
    'Sr',
    'Y',
    'Zr',
    'Nb',
    'Mo',
    'Tc',
    'Ru',
    'Rh',
    'Pd',
    'Ag',
    'Cd',
    'In',
    'Sn',
    'Sb',
    'Te',
    'I',
    'Xe',
    'Cs',
    'Ba',
    'La',
    'Ce',
    'Pr',
    'Nd',
    'Pm',
    'Sm',
    'Eu',
    'Gd',
    'Tb',
    'Dy',
    'Ho',
    'Er',
    'Tm',
    'Yb',
    'Lu',
    'Hf',
    'Ta',
    'W',
    'Re',
    'Os',
    'Ir',
    'Pt',
    'Au',
    'Hg',
    'Tl',
    'Pb',
    'Bi',
    'Po',
    'At',
    'Rn',
    'Fr',
    'Ra',
    'Ac',
    'Th',
    'Pa',
    'U',
    'Np',
    'Pu',
    'Am',
    'Cm',
    'Bk',
    'Cf',
    'Es',
    'Fm',
    'Md',
    'No',
    'Lr',
    'Rf',
    'Db',
    'Sg',
    'Bh',
    'Hs',
    'Mt',
    'Ds',
    'Rg',
    'Cn',
    'Nh',
    'Fl',
    'Mc',
    'Lv',
    'Ts',
    'Og'
];

/** GNDS nuclide name matcher (`symbol` + mass number + optional `_mN`). */
const GNDS_NAME_PATTERN = /^([A-Z][a-z]?)(\d{1,3})(?:_m(\d{1,2}))?$/;

/** Outcome of resolving a particle identifier. */
export interface ParticleTypeResolution {
    /** Whether the identifier maps to a canonical OpenMC particle. */
    ok: boolean;
    /** Resolved particle when `ok`. */
    particle?: OpenMCParticleType;
    /** What is wrong and how to fix it when not `ok`. */
    error?: string;
}

/** Whether a particle is offered by the common preset list. */
export function findParticlePreset(particle: OpenMCParticleType | undefined): OpenMCParticlePreset | undefined {
    if (!particle) {
        return undefined;
    }
    return OPENMC_PARTICLE_PRESETS.find(
        (preset) => preset.name === particle.name || (particle.pdg !== undefined && preset.pdg === particle.pdg)
    );
}

/** Label for a particle (preset label or raw canonical name). */
export function particleTypeLabel(particle: OpenMCParticleType): string {
    return findParticlePreset(particle)?.label ?? particle.name;
}

/** Tooltip that carries the OpenMC canonical name and PDG number. */
export function particleTypeTooltip(particle: OpenMCParticleType): string {
    const preset = findParticlePreset(particle);
    const effect = preset?.description ?? 'OpenMC particle identifier';
    const pdg = particle.pdg !== undefined ? String(particle.pdg) : 'unknown';
    return `${effect}. OpenMC name: ${particle.name} · PDG ${pdg}`;
}

/** Stable identity for a particle (used for keys and de-duplication). */
export function particleTypeKey(particle: OpenMCParticleType): string {
    return `${particle.name}|${particle.pdg ?? ''}`;
}

/** Whether two particle values identify the same OpenMC particle. */
export function sameParticleType(a: OpenMCParticleType | undefined, b: OpenMCParticleType | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    if (a.pdg !== undefined && b.pdg !== undefined) {
        return a.pdg === b.pdg;
    }
    return a.name === b.name;
}

/** Element atomic number from a canonical symbol (1-118), or undefined. */
function atomicNumber(symbol: string): number | undefined {
    const index = ATOMIC_SYMBOLS.indexOf(symbol);
    return index >= 0 ? index + 1 : undefined;
}

/** Canonical GNDS name for a PDG nuclear code. */
function nuclearName(z: number, a: number, m: number): string {
    const symbol = ATOMIC_SYMBOLS[z - 1];
    return m > 0 ? `${symbol}${a}_m${m}` : `${symbol}${a}`;
}

/**
 * Build a particle from a PDG number using OpenMC's rules: legacy indices
 * 0-3 map to neutron/photon/electron/positron, 1e9+ codes are nuclear PDG
 * numbers, and any other integer is an unknown particle (`pdg:<n>`).
 */
function particleFromPdg(pdg: number): ParticleTypeResolution {
    if (!Number.isInteger(pdg)) {
        return { ok: false, error: 'PDG number must be an integer' };
    }
    const legacy = [2112, 22, 11, -11][pdg];
    if (pdg >= 0 && pdg <= 3 && legacy !== undefined) {
        return { ok: true, particle: { name: canonicalNameFromPdg(legacy)!, pdg: legacy } };
    }
    if (pdg >= 1000000000) {
        const z = Math.floor(pdg / 10000) % 1000;
        const a = Math.floor(pdg / 10) % 1000;
        const m = pdg % 10;
        if (z < 1 || z > ATOMIC_SYMBOLS.length || a < 1 || a > 999) {
            return {
                ok: false,
                error: `PDG ${pdg} has an invalid nuclear Z/A/m code; use 1000000000 + Z×10000 + A×10 + metastable state`
            };
        }
        return { ok: true, particle: { name: nuclearName(z, a, m), pdg } };
    }
    return { ok: true, particle: { name: canonicalNameFromPdg(pdg) ?? `pdg:${pdg}`, pdg } };
}

/** Canonical OpenMC name for a PDG number, or undefined when it cannot be named. */
export function canonicalNameFromPdg(pdg: number): string | undefined {
    switch (pdg) {
        case 2112:
            return 'neutron';
        case 22:
            return 'photon';
        case 11:
            return 'electron';
        case -11:
            return 'positron';
        case 2212:
            return 'H1';
        case 1000010020:
            return 'H2';
        case 1000010030:
            return 'H3';
        case 1000020040:
            return 'He4';
        case 1000020030:
            return 'He3';
        default:
            break;
    }
    if (pdg >= 1000000000) {
        const z = Math.floor(pdg / 10000) % 1000;
        const a = Math.floor(pdg / 10) % 1000;
        const m = pdg % 10;
        if (z >= 1 && z <= ATOMIC_SYMBOLS.length && a >= 1 && a <= 999) {
            return nuclearName(z, a, m);
        }
        return undefined;
    }
    return undefined;
}

/** Parse a name, `pdg:` string, or GNDS nuclide name into a canonical particle. */
function particleFromName(value: string): ParticleTypeResolution {
    const name = value.trim();
    if (!name) {
        return { ok: false, error: 'Particle name cannot be empty' };
    }
    const alias = PARTICLE_ALIASES[name.toLowerCase()];
    if (alias !== undefined) {
        return particleFromPdg(alias);
    }
    if (name.toLowerCase().startsWith('pdg:')) {
        const numeric = Number(name.slice(4).trim());
        if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
            return { ok: false, error: `"${name}" does not contain a valid integer PDG number` };
        }
        return particleFromPdg(numeric);
    }
    if (/^[+-]?\d+$/.test(name)) {
        return particleFromPdg(Number(name));
    }
    const match = GNDS_NAME_PATTERN.exec(name);
    if (match) {
        const symbol = match[1];
        const z = atomicNumber(symbol);
        const a = Number(match[2]);
        const m = match[3] !== undefined ? Number(match[3]) : 0;
        if (z === undefined) {
            return { ok: false, error: `"${symbol}" is not a recognized element symbol` };
        }
        if (a < 1 || a > 999 || m < 0 || m > 9) {
            return { ok: false, error: `"${name}" has an invalid mass or metastable state` };
        }
        const pdg = 1000000000 + z * 10000 + a * 10 + m;
        return { ok: true, particle: { name: nuclearName(z, a, m), pdg } };
    }
    return {
        ok: false,
        error: `"${name}" is not a recognized OpenMC particle name; use a preset, a GNDS nuclide such as He4 or U235, or a PDG number`
    };
}

/**
 * Resolve a string, number, or `{name, pdg}` value against OpenMC's particle
 * identifiers. Invalid input returns an actionable error instead of guessing.
 */
export function resolveParticleType(value: unknown): ParticleTypeResolution {
    if (value === undefined || value === null) {
        return { ok: false, error: 'No particle type is selected' };
    }
    if (typeof value === 'number') {
        return particleFromPdg(value);
    }
    if (typeof value === 'string') {
        return particleFromName(value);
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        const candidate = value as { name?: unknown; pdg?: unknown };
        const hasName = typeof candidate.name === 'string' && candidate.name.trim().length > 0;
        const hasPdg = typeof candidate.pdg === 'number' && Number.isInteger(candidate.pdg);
        if (!hasName && !hasPdg) {
            return { ok: false, error: 'Particle type needs a name or a PDG number' };
        }
        const byName = hasName ? particleFromName(String(candidate.name)) : undefined;
        const byPdg = hasPdg ? particleFromPdg(candidate.pdg as number) : undefined;
        if (byName?.ok && byPdg?.ok) {
            if (byName.particle!.pdg !== byPdg.particle!.pdg) {
                return {
                    ok: false,
                    error: `Particle name "${String(candidate.name)}" and PDG ${String(candidate.pdg)} describe different particles`
                };
            }
            return byName;
        }
        if (byName?.ok) {
            return byName;
        }
        if (byPdg?.ok) {
            return byPdg;
        }
        return byName ?? byPdg ?? { ok: false, error: 'Particle type is invalid' };
    }
    return { ok: false, error: 'Particle type must be a name, PDG number, or particle object' };
}

/** Resolve a particle, returning undefined for invalid values. */
export function coerceParticleType(value: unknown): OpenMCParticleType | undefined {
    const result = resolveParticleType(value);
    return result.ok ? result.particle : undefined;
}

/**
 * Lenient normalization for project/XML import: known identifiers become the
 * canonical name + PDG form, while an unknown name is preserved so the user
 * sees it and can fix it rather than losing data silently.
 */
export function normalizeParticleType(value: unknown): OpenMCParticleType | undefined {
    const resolved = resolveParticleType(value);
    if (resolved.ok) {
        return resolved.particle;
    }
    if (typeof value === 'string' && value.trim()) {
        return { name: value.trim() };
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const candidate = value as { name?: unknown; pdg?: unknown };
        if (typeof candidate.name === 'string' && candidate.name.trim()) {
            return {
                name: candidate.name.trim(),
                ...(typeof candidate.pdg === 'number' && Number.isInteger(candidate.pdg) ? { pdg: candidate.pdg } : {})
            };
        }
    }
    return undefined;
}

/** Canonical name for a stored value, falling back to the raw name. */
export function particleTypeName(value: unknown): string | undefined {
    const resolved = resolveParticleType(value);
    if (resolved.ok) {
        return resolved.particle!.name;
    }
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const name = (value as { name?: unknown }).name;
        return typeof name === 'string' && name.trim() ? name.trim() : undefined;
    }
    return undefined;
}

/** PDG number for a stored value when known. */
export function particleTypePdg(value: unknown): number | undefined {
    const resolved = resolveParticleType(value);
    return resolved.ok ? resolved.particle!.pdg : undefined;
}

/** Whether a stored value maps to a canonical OpenMC particle. */
export function isKnownParticle(value: unknown): boolean {
    return resolveParticleType(value).ok;
}

/** Whether a particle is available on every supported OpenMC release (0.15.3+). */
export function isBaseParticle(particle: OpenMCParticleType): boolean {
    return BASE_PARTICLE_NAMES.has(particle.name.toLowerCase());
}

/** Whether a particle is allowed in a scope on the probed environment. */
export function isParticleSupported(particle: OpenMCParticleType, scope: OpenMCParticleScope, compat?: OpenMCCompat): boolean {
    if (!resolveParticleType(particle).ok) {
        return false;
    }
    const name = particle.name.toLowerCase();
    if (scope === 'weight-window') {
        return WEIGHT_WINDOW_PARTICLE_NAMES.has(name);
    }
    if (isBaseParticle(particle)) {
        return true;
    }
    // A missing probe result is not evidence of an unsupported environment;
    // only an explicit false (release without PDG-backed ParticleType) blocks.
    return compat?.generalizedParticles !== false;
}

/** Actionable reason a particle cannot be used in a scope, if any. */
export function particleSupportIssue(particle: OpenMCParticleType, scope: OpenMCParticleScope, compat?: OpenMCCompat): string | undefined {
    if (isParticleSupported(particle, scope, compat)) {
        return undefined;
    }
    const name = particleTypeName(particle) ?? particle.name;
    if (scope === 'weight-window') {
        return `OpenMC weight windows only apply to neutrons and photons; "${name}" cannot be used here. Choose neutron or photon.`;
    }
    return `Particle "${name}" requires OpenMC 0.16 or newer (PDG-backed ParticleType). Choose neutron, photon, electron, or positron, or update the configured Python environment.`;
}

/** Fallback particle used when generation must stay valid on older OpenMC. */
export function sanitizeSourceParticle(value: unknown, compat?: OpenMCCompat): { particle: OpenMCParticleType; warning?: string } {
    const particle = coerceParticleType(value);
    if (!particle) {
        const name = typeof value === 'string' ? value : undefined;
        return {
            particle: NEUTRON_PARTICLE,
            warning: name
                ? `Source particle "${name}" is not a recognized OpenMC particle; wrote neutron instead`
                : 'Source particle is not a recognized OpenMC particle; wrote neutron instead'
        };
    }
    if (!isParticleSupported(particle, 'source', compat)) {
        return {
            particle: NEUTRON_PARTICLE,
            warning: `Source particle "${particle.name}" requires OpenMC 0.16 or newer; wrote neutron instead`
        };
    }
    return { particle };
}

/** Fallback particle for weight-window sets/generators (neutron/photon only). */
export function sanitizeWeightWindowParticle(value: unknown, label: string): { particle: OpenMCParticleType; warning?: string } {
    const particle = coerceParticleType(value);
    if (!particle) {
        return value === undefined || value === null
            ? { particle: NEUTRON_PARTICLE }
            : {
                  particle: NEUTRON_PARTICLE,
                  warning: `${label} particle is not a recognized OpenMC particle; wrote neutron instead`
              };
    }
    if (!isParticleSupported(particle, 'weight-window')) {
        return {
            particle: NEUTRON_PARTICLE,
            warning: `${label} particle "${particle.name}" is not supported by OpenMC weight windows; wrote neutron instead`
        };
    }
    return { particle };
}

/**
 * Legacy numeric particle bins used by pre-PDG project files: 1 = neutron,
 * 2 = photon, 3 = electron, 4 = positron.
 */
export function particleFromLegacyBin(bin: number): OpenMCParticleType | undefined {
    switch (bin) {
        case 1:
            return NEUTRON_PARTICLE;
        case 2:
            return PHOTON_PARTICLE;
        case 3:
            return { name: 'electron', pdg: 11 };
        case 4:
            return { name: 'positron', pdg: -11 };
        default:
            return undefined;
    }
}

/** Legacy numeric bin for a particle, or undefined when it has no legacy code. */
export function legacyParticleBin(particle: OpenMCParticleType): number | undefined {
    const name = particle.name.toLowerCase();
    if (name === 'neutron') {
        return 1;
    }
    if (name === 'photon') {
        return 2;
    }
    if (name === 'electron') {
        return 3;
    }
    if (name === 'positron') {
        return 4;
    }
    return undefined;
}

/** Legacy numeric bins for a list, or an empty list when any particle needs the new field. */
export function legacyParticleBins(particles: OpenMCParticleType[]): number[] {
    const bins = particles.map(legacyParticleBin);
    return bins.every((bin): bin is number => bin !== undefined) ? bins : [];
}

/** Look up a preset by canonical name or PDG. */
export function particlePreset(nameOrPdg: string | number): OpenMCParticlePreset | undefined {
    return OPENMC_PARTICLE_PRESETS.find((preset) => preset.name === nameOrPdg || preset.pdg === nameOrPdg);
}
