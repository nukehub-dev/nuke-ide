#!/usr/bin/env node
/**
 * Generate the nuke-visualizer colormap library from authoritative preset
 * sources.
 *
 * Emits extensions/nuke-visualizer/src/browser/viewer-core/colormaps.ts
 * (committed; regenerate when the preset list changes). The emitted module
 * is prettier-formatted (prettier from the repo root node_modules is run
 * over the output).
 *
 * Usage:
 *   node scripts/generate-colormaps.js \
 *       --paraview <path-to-ParaView-Remoting/Views/ColorMaps.json> \
 *       [--paraview <older-ColorMaps.json> ...] \
 *       --matplotlib <path-to-matplotlib-dump.json> \
 *       [--out <ts-output-path>]
 *
 * Sources, in priority order (first match wins for each requested name):
 *
 *  1. `--paraview` files — ParaView `Remoting/Views/ColorMaps.json` (any
 *     version; the trailing comma ParaView writes is tolerated). Continuous
 *     presets use `RGBPoints` ([x,r,g,b,...]); categorical presets use
 *     `IndexedColors` ([r,g,b,...]) and are expanded to evenly spaced
 *     gradient stops. Tested against ParaView 6.2 (primary) and 5.x (for
 *     presets dropped from 6.x); `Red to Blue Rainbow` is derived by
 *     mirroring `Blue to Red Rainbow` (the reversed preset ships only in
 *     ParaView's generated `_colorMaps` module, never in ColorMaps.json).
 *  2. `--matplotlib` dump — JSON object mapping colormap name to 256
 *     [r,g,b] samples (channels in [0,1]). Produce it with:
 *
 *       python3 - <<'EOF'
 *       import json, matplotlib, cmocean
 *       names = {'Spectral': matplotlib.colormaps['Spectral'],
 *                'RdYlBu': matplotlib.colormaps['RdYlBu'],
 *                'RdYlGn': matplotlib.colormaps['RdYlGn'],
 *                'RdBu': matplotlib.colormaps['RdBu'],
 *                'Seismic': matplotlib.colormaps['seismic'],
 *                'Twilight': matplotlib.colormaps['twilight'],
 *                'Ocean': matplotlib.colormaps['ocean'],
 *                'Balance': cmocean.cm.balance}
 *       json.dump({n: [[round(c, 6) for c in cm(i / 255)[:3]] for i in range(256)]
 *                  for n, cm in names.items()}, open('cm-matplotlib.json', 'w'))
 *       EOF
 *
 *     These eight names never shipped in ParaView's ColorMaps.json (the old
 *     trame-era list included them but `ApplyPreset` silently no-ops on
 *     unknown names); matplotlib/cmocean carry the canonical definitions
 *     (BSD-licensed).
 *
 * Old-list names with no authoritative data anywhere (ParaView 4.x legacy
 * `Yellow 5`, `Green 4`, `Purple 3`, `Red 2`, `Steelblue`, `Gray 5` and the
 * procedural `2D`/`2D Checkerboard`/`2D Extents`) are dropped and reported.
 *
 * Licenses: ParaView ColorMaps.json data is BSD-3-Clause (Kitware); the
 * 256-stop matplotlib-derived presets in it (Viridis/Plasma/Inferno/Magma/
 * Cividis) are CC0; the `--matplotlib` dump data is matplotlib (BSD) /
 * cmocean (MIT).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT_DIR, 'extensions', 'nuke-visualizer', 'src', 'browser', 'viewer-core', 'colormaps.ts');

/** Old trame-era `COLOR_MAPS` order, minus the nine names that exist in no authoritative source. */
const WANTED_NAMES = [
    'Viridis',
    'Plasma',
    'Inferno',
    'Magma',
    'Cividis',
    'Cool to Warm',
    'Cool to Warm (Extended)',
    'Warm to Cool',
    'Black-Body Radiation',
    'X Ray',
    'Blue to Red Rainbow',
    'Red to Blue Rainbow',
    'Rainbow Desaturated',
    'Rainbow Uniform',
    'Jet',
    'Hot',
    'Cool',
    'Spectral',
    'RdYlBu',
    'RdYlGn',
    'PuOr',
    'PRGn',
    'BrBG',
    'PiYG',
    'RdBu',
    'Seismic',
    'Balance',
    'Twilight',
    'Haze',
    'Earth',
    'Ocean',
    'Blue Orange (div)',
    'Black, Blue and White',
    'Black, Orange and White'
];

/** Old name → preset name in the ParaView file, when they differ. */
const PARAVIEW_ALIASES = {
    Hot: '2hot',
    Earth: 'gist_earth',
    'Blue Orange (div)': 'Blue Orange (divergent)',
    'Black, Body Radiation': 'Black-Body Radiation'
};

/** Old name → key in the --matplotlib dump (data source: matplotlib / cmocean). */
const MATPLOTLIB_SOURCES = {
    Spectral: 'Spectral',
    RdYlBu: 'RdYlBu',
    RdYlGn: 'RdYlGn',
    RdBu: 'RdBu',
    Seismic: 'seismic',
    Twilight: 'twilight',
    Ocean: 'ocean',
    Balance: 'balance'
};

/** Old name → ParaView preset to mirror (positions reflected, order reversed). */
const REVERSE_OF = {
    'Red to Blue Rainbow': 'Blue to Red Rainbow'
};

/** Names from the old list intentionally dropped (no data in any source). */
const DROPPED_NAMES = ['Yellow 5', 'Green 4', 'Purple 3', 'Red 2', 'Steelblue', 'Gray 5', '2D', '2D Checkerboard', '2D Extents'];

function parseArgs(argv) {
    const args = { paraview: [], matplotlib: undefined, out: DEFAULT_OUT };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--paraview') {
            args.paraview.push(argv[++i]);
        } else if (argv[i] === '--matplotlib') {
            args.matplotlib = argv[++i];
        } else if (argv[i] === '--out') {
            args.out = argv[++i];
        } else {
            throw new Error(`Unknown argument: ${argv[i]}`);
        }
    }
    if (args.paraview.length === 0) {
        throw new Error('At least one --paraview <ColorMaps.json> path is required');
    }
    return args;
}

/** ParaView writes a trailing comma before the closing `]` — strip it. */
function loadParaViewColorMaps(file) {
    const raw = fs.readFileSync(file, 'utf8').replace(/,\s*\]/g, ']');
    const presets = JSON.parse(raw);
    const byName = new Map();
    for (const preset of presets) {
        if (preset.Name && !byName.has(preset.Name)) {
            byName.set(preset.Name, preset);
        }
    }
    return byName;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function paraViewPresetToDefinition(name, preset) {
    const def = {
        name,
        paraviewPreset: preset.Name,
        colorSpace: preset.ColorSpace || (preset.IndexedColors ? 'Indexed' : 'RGB'),
        nanColor: preset.NanColor ? preset.NanColor.map(round6) : null,
        stops: []
    };
    if (preset.RGBPoints) {
        const points = preset.RGBPoints;
        for (let i = 0; i + 3 < points.length + 1; i += 4) {
            def.stops.push({
                position: round6(points[i]),
                red: round6(points[i + 1]),
                green: round6(points[i + 2]),
                blue: round6(points[i + 3])
            });
        }
    } else if (preset.IndexedColors) {
        const colors = preset.IndexedColors;
        const count = colors.length / 3;
        for (let i = 0; i < count; i++) {
            def.stops.push({
                position: count === 1 ? 0 : round6(i / (count - 1)),
                red: round6(colors[i * 3]),
                green: round6(colors[i * 3 + 1]),
                blue: round6(colors[i * 3 + 2])
            });
        }
    } else {
        throw new Error(`Preset ${preset.Name} has neither RGBPoints nor IndexedColors`);
    }
    if (def.stops.length < 2) {
        throw new Error(`Preset ${preset.Name} resolved to fewer than 2 stops`);
    }
    return def;
}

/** Mirror a definition: reverse stop order and reflect positions across the domain. */
function reverseDefinition(def) {
    const first = def.stops[0].position;
    const last = def.stops[def.stops.length - 1].position;
    return {
        ...def,
        stops: [...def.stops].reverse().map((s) => ({ ...s, position: round6(first + last - s.position) }))
    };
}

function matplotlibPresetToDefinition(name, samples) {
    if (!Array.isArray(samples) || samples.length < 2) {
        throw new Error(`Matplotlib dump entry ${name} must hold at least 2 samples`);
    }
    const last = samples.length - 1;
    return {
        name,
        paraviewPreset: null,
        colorSpace: 'RGB',
        nanColor: null,
        stops: samples.map((rgb, i) => ({
            position: i === 0 ? 0 : i === last ? 1 : round6(i / last),
            red: round6(rgb[0]),
            green: round6(rgb[1]),
            blue: round6(rgb[2])
        }))
    };
}

function constName(name) {
    return name
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_')
        .toUpperCase();
}

function emitStops(stops) {
    return stops.map((s) => `    { position: ${s.position}, red: ${s.red}, green: ${s.green}, blue: ${s.blue} }`).join(',\n');
}

function emitDefinition(def) {
    const base = constName(def.name);
    const nan = def.nanColor ? `[${def.nanColor.join(', ')}] as const` : 'null';
    const preset = def.paraviewPreset ? `'${def.paraviewPreset}'` : 'null';
    return `const ${base}_STOPS: readonly ColormapStop[] = [\n${emitStops(def.stops)}\n];\n\nconst ${base}_DEF: ColormapDefinition = {\n    name: '${def.name}',\n    paraviewPreset: ${preset},\n    colorSpace: '${def.colorSpace}',\n    nanColor: ${nan},\n    stops: ${base}_STOPS\n};`;
}

function generate(definitions, outFile) {
    const namesList = definitions.map((d) => `    '${d.name}'`).join(',\n');
    const recordEntries = definitions.map((d) => `    '${d.name}': ${constName(d.name)}_DEF`).join(',\n');
    const content = `// *****************************************************************************
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

// GENERATED FILE — do not edit by hand. Regenerate with:
//   node scripts/generate-colormaps.js --paraview <ColorMaps.json> [--paraview <older.json>] --matplotlib <dump.json>

/**
 * Colormap (LUT) library for the native 3D viewer core.
 *
 * Control points are verbatim copies of the preset entries, applied
 * client-side with ParaView \`lut.ApplyPreset(name, true)\` semantics (linear
 * interpolation between control points, clamped at the ends, \`nanColor\` for
 * non-finite values when the preset defines one). Sources per preset:
 *
 * - ParaView \`Remoting/Views/ColorMaps.json\` (BSD-3-Clause, Kitware); the
 *   bundled 256-stop matplotlib presets (Viridis/Plasma/Inferno/Magma/
 *   Cividis) are CC0 per their \`License\` fields.
 * - matplotlib / cmocean canonical definitions (BSD / MIT) for the eight
 *   names (\`Spectral\`, \`RdYlBu\`, \`RdYlGn\`, \`RdBu\`, \`Seismic\`,
 *   \`Twilight\`, \`Ocean\`, \`Balance\`) that never shipped in ParaView's
 *   ColorMaps.json.
 *
 * Preset notes:
 *
 * - \`Hot\`, \`Earth\`, \`Blue Orange (div)\`, \`Black, Body Radiation\` are
 *   the old trame-era names for the ParaView presets \`2hot\`,
 *   \`gist_earth\`, \`Blue Orange (divergent)\`, \`Black-Body Radiation\`.
 * - \`Cool\` is a categorical preset (\`IndexedColors\`); it is exposed as
 *   evenly spaced gradient stops.
 * - Several presets store control points on a non-[0,1] axis (\`Jet\`/\`2hot\`/
 *   the Brewer diverging maps on [-1, 1], \`Cividis\` on [0, 255], \`Blue
 *   Orange (divergent)\` on [-30.34, 2.285]); use {@link normalizeStops} (or
 *   the samplers, which apply it) before mapping scalar values.
 *
 * ParaView interpolates in each preset's native color space (Lab for the
 * matplotlib maps); the samplers below interpolate in sRGB. Over the dense
 * 256-stop tables the difference is far below one 8-bit code value, so the
 * sRGB path is used to stay dependency-free.
 *
 * Pure functions + types only; no three.js, no DOM.
 */

/** Names of all colormaps, in the picker display order. */
export const COLORMAP_NAMES = [
${namesList}
] as const;

/** Name of a colormap in the library. */
export type ColormapName = (typeof COLORMAP_NAMES)[number];

/** A single LUT control point: scalar position plus an sRGB color. */
export interface ColormapStop {
    readonly position: number;
    readonly red: number;
    readonly green: number;
    readonly blue: number;
}

/** sRGB color with channels in [0, 1]. */
export type RgbColor = readonly [number, number, number];

/**
 * One colormap: control points verbatim from the preset source plus the
 * metadata needed to apply it.
 */
export interface ColormapDefinition {
    /** Picker name (old trame-era naming kept for continuity). */
    readonly name: ColormapName;
    /** Source preset name in ParaView ColorMaps.json, or null for matplotlib/cmocean-sourced maps. */
    readonly paraviewPreset: string | null;
    /** Color space of the source preset (\`Indexed\` for categorical maps). */
    readonly colorSpace: string;
    /** Color for non-finite values, or null when the preset defines none. */
    readonly nanColor: RgbColor | null;
    /** Control points in preset order (positions ascending). */
    readonly stops: readonly ColormapStop[];
}

/** Runtime guard for colormap names. */
export function isColormapName(name: string): name is ColormapName {
    return (COLORMAP_NAMES as readonly string[]).includes(name);
}

/** Look up a definition by name, or undefined when unknown. */
export function getColormap(name: string): ColormapDefinition | undefined {
    if (!isColormapName(name)) {
        return undefined;
    }
    return COLORMAPS[name];
}

/**
 * Rescale a definition's control-point positions to [0, 1].
 * Verbatim presets often span a different domain ([-1, 1], [0, 255], ...).
 */
export function normalizeStops(definition: ColormapDefinition): ColormapStop[] {
    const stops = definition.stops;
    const first = stops[0].position;
    const last = stops[stops.length - 1].position;
    const span = last - first;
    if (span <= 0) {
        return stops.map((stop) => ({ ...stop, position: 0 }));
    }
    return stops.map((stop) => ({ ...stop, position: (stop.position - first) / span }));
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Sample a colormap at scalar position \`t\` in [0, 1] (clamped).
 * Linear interpolation between the normalized control points.
 */
export function sampleColormap(definition: ColormapDefinition, t: number): [number, number, number] {
    const stops = normalizeStops(definition);
    const clamped = Math.min(1, Math.max(0, t));
    for (let i = 1; i < stops.length; i++) {
        if (clamped <= stops[i].position || i === stops.length - 1) {
            const prev = stops[i - 1];
            const next = stops[i];
            const span = next.position - prev.position;
            const local = span <= 0 ? 0 : (clamped - prev.position) / span;
            return [lerp(prev.red, next.red, local), lerp(prev.green, next.green, local), lerp(prev.blue, next.blue, local)];
        }
    }
    const last = stops[stops.length - 1];
    return [last.red, last.green, last.blue];
}

/**
 * Expand a colormap to a fixed-size lookup table of \`size\` sRGB entries.
 * Entry \`i\` samples scalar position \`i / (size - 1)\`.
 */
export function colormapToLut(definition: ColormapDefinition, size = 256): [number, number, number][] {
    const lut: [number, number, number][] = [];
    for (let i = 0; i < size; i++) {
        lut.push(sampleColormap(definition, size === 1 ? 0 : i / (size - 1)));
    }
    return lut;
}

/** Format an sRGB color (channels in [0, 1]) as a CSS \`rgb(...)\` string. */
export function rgbToCss(color: readonly [number, number, number]): string {
    const channels = color.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255));
    return \`rgb(\${channels[0]}, \${channels[1]}, \${channels[2]})\`;
}

/**
 * Build a CSS \`linear-gradient(...)\` for a legend bar by sampling the map
 * at \`samples\` evenly spaced positions.
 */
export function colormapToCssGradient(definition: ColormapDefinition, samples = 8): string {
    const stops: string[] = [];
    for (let i = 0; i < samples; i++) {
        stops.push(rgbToCss(sampleColormap(definition, samples === 1 ? 0 : i / (samples - 1))));
    }
    return \`linear-gradient(to right, \${stops.join(', ')})\`;
}

${definitions.map(emitDefinition).join('\n\n')}

/** Colormap library keyed by picker name. */
export const COLORMAPS: Record<ColormapName, ColormapDefinition> = {
${recordEntries}
};
`;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, content);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const sources = args.paraview.map(loadParaViewColorMaps);
    const matplotlib = args.matplotlib ? JSON.parse(fs.readFileSync(args.matplotlib, 'utf8')) : {};

    const definitions = [];
    const missing = [];
    for (const name of WANTED_NAMES) {
        const paraViewName = PARAVIEW_ALIASES[name] || name;
        const preset = sources.map((byName) => byName.get(paraViewName)).find((p) => p);
        if (preset) {
            definitions.push(paraViewPresetToDefinition(name, preset));
            continue;
        }
        const mirrorOf = REVERSE_OF[name];
        const mirrorPreset = mirrorOf ? sources.map((byName) => byName.get(mirrorOf)).find((p) => p) : undefined;
        if (mirrorPreset) {
            definitions.push(reverseDefinition(paraViewPresetToDefinition(name, mirrorPreset)));
            continue;
        }
        const dumpKey = MATPLOTLIB_SOURCES[name];
        if (dumpKey && matplotlib[dumpKey]) {
            definitions.push(matplotlibPresetToDefinition(name, matplotlib[dumpKey]));
            continue;
        }
        missing.push(name);
    }

    generate(definitions, args.out);
    console.log(`[generate-colormaps] Wrote ${definitions.length} colormaps to ${path.relative(ROOT_DIR, args.out)}`);
    if (missing.length) {
        console.log(`[generate-colormaps] WARNING: no data found for: ${missing.join(', ')}`);
    }
    console.log(`[generate-colormaps] Intentionally dropped (no authoritative source): ${DROPPED_NAMES.join(', ')}`);

    try {
        execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prettier', '--write', args.out], {
            cwd: ROOT_DIR,
            stdio: 'inherit'
        });
    } catch (e) {
        console.log(`[generate-colormaps] WARNING: prettier failed (${e.message}); run yarn format before committing`);
    }
}

main();
