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
 * Short-list colormap (LUT) pack for the native 3D viewer core.
 *
 * Ported from ParaView `Remoting/Views/ColorMaps.json` (probed at version
 * 6.2.20260906): the RGB control points below are verbatim copies of the
 * preset entries, applied client-side with `lut.ApplyPreset(name, true)`
 * semantics (linear interpolation between control points, clamped at the
 * ends, `nanColor` for NaN values).
 *
 * Preset mapping notes (the trame short list in
 * `python/plugins/base/lib/common.py::COLOR_MAPS_SHORT` predates the current
 * preset file, so two names need an alias):
 *
 * - `Plasma`, `Viridis`, `Inferno`, `Jet` map 1:1 to same-named presets.
 * - `Hot` has no same-named preset in `ColorMaps.json`; it maps to the
 *   `2hot` preset (the classic black-body black to red to yellow to white
 *   gradient).
 * - `Cool` is a categorical preset (`IndexedColors`, 7 entries); it is
 *   exposed here as 7 evenly spaced gradient stops.
 * - `Jet` and `2hot` store control points on a [-1, 1] axis; use
 *   {@link normalizeStops} (or the samplers, which apply it) before mapping
 *   scalar values.
 *
 * ParaView interpolates in each preset's native color space (Lab for the
 * matplotlib maps); the samplers below interpolate in sRGB. Over the dense
 * 256-stop tables the difference is far below one 8-bit code value, so the
 * sRGB path is used to stay dependency-free.
 *
 * Pure functions + types only; no trame, no vuetify, no DOM.
 */

/** Names of the six short-list maps (mirrors `COLOR_MAPS_SHORT`). */
export const SHORT_COLORMAP_NAMES = ['Plasma', 'Viridis', 'Inferno', 'Jet', 'Hot', 'Cool'] as const;

/** Name of one of the six short-list maps. */
export type ShortColormapName = (typeof SHORT_COLORMAP_NAMES)[number];

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
 * One ported colormap: control points verbatim from `ColorMaps.json` plus
 * the preset metadata needed to apply it.
 */
export interface ColormapDefinition {
    /** Short-list name used by the toolbar model. */
    readonly name: ShortColormapName;
    /** Preset name in ParaView `ColorMaps.json`. */
    readonly paraviewPreset: string;
    /** Preset color space (`Indexed` for the categorical `Cool` map). */
    readonly colorSpace: string;
    /** Color for NaN values, or null when the preset defines none. */
    readonly nanColor: RgbColor | null;
    /** Control points in preset order (positions ascending). */
    readonly stops: readonly ColormapStop[];
}

/** Runtime guard for short-list colormap names. */
export function isShortColormapName(name: string): name is ShortColormapName {
    return (SHORT_COLORMAP_NAMES as readonly string[]).includes(name);
}

/** Look up a short-list definition by name, or undefined when unknown. */
export function getColormap(name: string): ColormapDefinition | undefined {
    if (!isShortColormapName(name)) {
        return undefined;
    }
    return SHORT_COLORMAPS[name];
}

/**
 * Rescale a definition's control-point positions to [0, 1].
 * Verbatim presets already span [0, 1] except `Jet` and `Hot` (`2hot`),
 * which are stored on a [-1, 1] axis.
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
 * Sample a colormap at scalar position `t` in [0, 1] (clamped).
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
 * Expand a colormap to a fixed-size lookup table of `size` sRGB entries.
 * Entry `i` samples scalar position `i / (size - 1)`.
 */
export function colormapToLut(definition: ColormapDefinition, size = 256): [number, number, number][] {
    const lut: [number, number, number][] = [];
    for (let i = 0; i < size; i++) {
        lut.push(sampleColormap(definition, size === 1 ? 0 : i / (size - 1)));
    }
    return lut;
}

/** Format an sRGB color (channels in [0, 1]) as a CSS `rgb(...)` string. */
export function rgbToCss(color: readonly [number, number, number]): string {
    const channels = color.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255));
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

/**
 * Build a CSS `linear-gradient(...)` for a legend bar by sampling the map
 * at `samples` evenly spaced positions.
 */
export function colormapToCssGradient(definition: ColormapDefinition, samples = 8): string {
    const stops: string[] = [];
    for (let i = 0; i < samples; i++) {
        stops.push(rgbToCss(sampleColormap(definition, samples === 1 ? 0 : i / (samples - 1))));
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
}

const PLASMA_STOPS: readonly ColormapStop[] = [
    { position: 0.0, red: 0.050383, green: 0.029803, blue: 0.527975 },
    { position: 0.003922, red: 0.063536, green: 0.028426, blue: 0.533124 },
    { position: 0.007843, red: 0.075353, green: 0.027206, blue: 0.538007 },
    { position: 0.011765, red: 0.086222, green: 0.026125, blue: 0.542658 },
    { position: 0.015686, red: 0.096379, green: 0.025165, blue: 0.547103 },
    { position: 0.019608, red: 0.10598, green: 0.024309, blue: 0.551368 },
    { position: 0.023529, red: 0.115124, green: 0.023556, blue: 0.555468 },
    { position: 0.027451, red: 0.123903, green: 0.022878, blue: 0.559423 },
    { position: 0.031373, red: 0.132381, green: 0.022258, blue: 0.56325 },
    { position: 0.035294, red: 0.140603, green: 0.021687, blue: 0.566959 },
    { position: 0.039216, red: 0.148607, green: 0.021154, blue: 0.570562 },
    { position: 0.043137, red: 0.156421, green: 0.020651, blue: 0.574065 },
    { position: 0.047059, red: 0.16407, green: 0.020171, blue: 0.577478 },
    { position: 0.05098, red: 0.171574, green: 0.019706, blue: 0.580806 },
    { position: 0.054902, red: 0.17895, green: 0.019252, blue: 0.584054 },
    { position: 0.058824, red: 0.186213, green: 0.018803, blue: 0.587228 },
    { position: 0.062745, red: 0.193374, green: 0.018354, blue: 0.59033 },
    { position: 0.066667, red: 0.200445, green: 0.017902, blue: 0.593364 },
    { position: 0.070588, red: 0.207435, green: 0.017442, blue: 0.596333 },
    { position: 0.07451, red: 0.21435, green: 0.016973, blue: 0.599239 },
    { position: 0.078431, red: 0.221197, green: 0.016497, blue: 0.602083 },
    { position: 0.082353, red: 0.227983, green: 0.016007, blue: 0.604867 },
    { position: 0.086275, red: 0.234715, green: 0.015502, blue: 0.607592 },
    { position: 0.090196, red: 0.241396, green: 0.014979, blue: 0.610259 },
    { position: 0.094118, red: 0.248032, green: 0.014439, blue: 0.612868 },
    { position: 0.098039, red: 0.254627, green: 0.013882, blue: 0.615419 },
    { position: 0.101961, red: 0.261183, green: 0.013308, blue: 0.617911 },
    { position: 0.105882, red: 0.267703, green: 0.012716, blue: 0.620346 },
    { position: 0.109804, red: 0.274191, green: 0.012109, blue: 0.622722 },
    { position: 0.113725, red: 0.280648, green: 0.011488, blue: 0.625038 },
    { position: 0.117647, red: 0.287076, green: 0.010855, blue: 0.627295 },
    { position: 0.121569, red: 0.293478, green: 0.010213, blue: 0.62949 },
    { position: 0.12549, red: 0.299855, green: 0.009561, blue: 0.631624 },
    { position: 0.129412, red: 0.30621, green: 0.008902, blue: 0.633694 },
    { position: 0.133333, red: 0.312543, green: 0.008239, blue: 0.6357 },
    { position: 0.137255, red: 0.318856, green: 0.007576, blue: 0.63764 },
    { position: 0.141176, red: 0.32515, green: 0.006915, blue: 0.639512 },
    { position: 0.145098, red: 0.331426, green: 0.006261, blue: 0.641316 },
    { position: 0.14902, red: 0.337683, green: 0.005618, blue: 0.643049 },
    { position: 0.152941, red: 0.343925, green: 0.004991, blue: 0.64471 },
    { position: 0.156863, red: 0.35015, green: 0.004382, blue: 0.646298 },
    { position: 0.160784, red: 0.356359, green: 0.003798, blue: 0.64781 },
    { position: 0.164706, red: 0.362553, green: 0.003243, blue: 0.649245 },
    { position: 0.168627, red: 0.368733, green: 0.002724, blue: 0.650601 },
    { position: 0.172549, red: 0.374897, green: 0.002245, blue: 0.651876 },
    { position: 0.176471, red: 0.381047, green: 0.001814, blue: 0.653068 },
    { position: 0.180392, red: 0.387183, green: 0.001434, blue: 0.654177 },
    { position: 0.184314, red: 0.393304, green: 0.001114, blue: 0.655199 },
    { position: 0.188235, red: 0.399411, green: 0.000859, blue: 0.656133 },
    { position: 0.192157, red: 0.405503, green: 0.000678, blue: 0.656977 },
    { position: 0.196078, red: 0.41158, green: 0.000577, blue: 0.65773 },
    { position: 0.2, red: 0.417642, green: 0.000564, blue: 0.65839 },
    { position: 0.203922, red: 0.423689, green: 0.000646, blue: 0.658956 },
    { position: 0.207843, red: 0.429719, green: 0.000831, blue: 0.659425 },
    { position: 0.211765, red: 0.435734, green: 0.001127, blue: 0.659797 },
    { position: 0.215686, red: 0.441732, green: 0.00154, blue: 0.660069 },
    { position: 0.219608, red: 0.447714, green: 0.00208, blue: 0.66024 },
    { position: 0.223529, red: 0.453677, green: 0.002755, blue: 0.66031 },
    { position: 0.227451, red: 0.459623, green: 0.003574, blue: 0.660277 },
    { position: 0.231373, red: 0.46555, green: 0.004545, blue: 0.660139 },
    { position: 0.235294, red: 0.471457, green: 0.005678, blue: 0.659897 },
    { position: 0.239216, red: 0.477344, green: 0.00698, blue: 0.659549 },
    { position: 0.243137, red: 0.48321, green: 0.00846, blue: 0.659095 },
    { position: 0.247059, red: 0.489055, green: 0.010127, blue: 0.658534 },
    { position: 0.25098, red: 0.494877, green: 0.01199, blue: 0.657865 },
    { position: 0.254902, red: 0.500678, green: 0.014055, blue: 0.657088 },
    { position: 0.258824, red: 0.506454, green: 0.016333, blue: 0.656202 },
    { position: 0.262745, red: 0.512206, green: 0.018833, blue: 0.655209 },
    { position: 0.266667, red: 0.517933, green: 0.021563, blue: 0.654109 },
    { position: 0.270588, red: 0.523633, green: 0.024532, blue: 0.652901 },
    { position: 0.27451, red: 0.529306, green: 0.027747, blue: 0.651586 },
    { position: 0.278431, red: 0.534952, green: 0.031217, blue: 0.650165 },
    { position: 0.282353, red: 0.54057, green: 0.03495, blue: 0.64864 },
    { position: 0.286275, red: 0.546157, green: 0.038954, blue: 0.64701 },
    { position: 0.290196, red: 0.551715, green: 0.043136, blue: 0.645277 },
    { position: 0.294118, red: 0.557243, green: 0.047331, blue: 0.643443 },
    { position: 0.298039, red: 0.562738, green: 0.051545, blue: 0.641509 },
    { position: 0.301961, red: 0.568201, green: 0.055778, blue: 0.639477 },
    { position: 0.305882, red: 0.573632, green: 0.060028, blue: 0.637349 },
    { position: 0.309804, red: 0.579029, green: 0.064296, blue: 0.635126 },
    { position: 0.313725, red: 0.584391, green: 0.068579, blue: 0.632812 },
    { position: 0.317647, red: 0.589719, green: 0.072878, blue: 0.630408 },
    { position: 0.321569, red: 0.595011, green: 0.07719, blue: 0.627917 },
    { position: 0.32549, red: 0.600266, green: 0.081516, blue: 0.625342 },
    { position: 0.329412, red: 0.605485, green: 0.085854, blue: 0.622686 },
    { position: 0.333333, red: 0.610667, green: 0.090204, blue: 0.619951 },
    { position: 0.337255, red: 0.615812, green: 0.094564, blue: 0.61714 },
    { position: 0.341176, red: 0.620919, green: 0.098934, blue: 0.614257 },
    { position: 0.345098, red: 0.625987, green: 0.103312, blue: 0.611305 },
    { position: 0.34902, red: 0.631017, green: 0.107699, blue: 0.608287 },
    { position: 0.352941, red: 0.636008, green: 0.112092, blue: 0.605205 },
    { position: 0.356863, red: 0.640959, green: 0.116492, blue: 0.602065 },
    { position: 0.360784, red: 0.645872, green: 0.120898, blue: 0.598867 },
    { position: 0.364706, red: 0.650746, green: 0.125309, blue: 0.595617 },
    { position: 0.368627, red: 0.65558, green: 0.129725, blue: 0.592317 },
    { position: 0.372549, red: 0.660374, green: 0.134144, blue: 0.588971 },
    { position: 0.376471, red: 0.665129, green: 0.138566, blue: 0.585582 },
    { position: 0.380392, red: 0.669845, green: 0.142992, blue: 0.582154 },
    { position: 0.384314, red: 0.674522, green: 0.147419, blue: 0.578688 },
    { position: 0.388235, red: 0.67916, green: 0.151848, blue: 0.575189 },
    { position: 0.392157, red: 0.683758, green: 0.156278, blue: 0.57166 },
    { position: 0.396078, red: 0.688318, green: 0.160709, blue: 0.568103 },
    { position: 0.4, red: 0.69284, green: 0.165141, blue: 0.564522 },
    { position: 0.403922, red: 0.697324, green: 0.169573, blue: 0.560919 },
    { position: 0.407843, red: 0.701769, green: 0.174005, blue: 0.557296 },
    { position: 0.411765, red: 0.706178, green: 0.178437, blue: 0.553657 },
    { position: 0.415686, red: 0.710549, green: 0.182868, blue: 0.550004 },
    { position: 0.419608, red: 0.714883, green: 0.187299, blue: 0.546338 },
    { position: 0.423529, red: 0.719181, green: 0.191729, blue: 0.542663 },
    { position: 0.427451, red: 0.723444, green: 0.196158, blue: 0.538981 },
    { position: 0.431373, red: 0.72767, green: 0.200586, blue: 0.535293 },
    { position: 0.435294, red: 0.731862, green: 0.205013, blue: 0.531601 },
    { position: 0.439216, red: 0.736019, green: 0.209439, blue: 0.527908 },
    { position: 0.443137, red: 0.740143, green: 0.213864, blue: 0.524216 },
    { position: 0.447059, red: 0.744232, green: 0.218288, blue: 0.520524 },
    { position: 0.45098, red: 0.748289, green: 0.222711, blue: 0.516834 },
    { position: 0.454902, red: 0.752312, green: 0.227133, blue: 0.513149 },
    { position: 0.458824, red: 0.756304, green: 0.231555, blue: 0.509468 },
    { position: 0.462745, red: 0.760264, green: 0.235976, blue: 0.505794 },
    { position: 0.466667, red: 0.764193, green: 0.240396, blue: 0.502126 },
    { position: 0.470588, red: 0.76809, green: 0.244817, blue: 0.498465 },
    { position: 0.47451, red: 0.771958, green: 0.249237, blue: 0.494813 },
    { position: 0.478431, red: 0.775796, green: 0.253658, blue: 0.491171 },
    { position: 0.482353, red: 0.779604, green: 0.258078, blue: 0.487539 },
    { position: 0.486275, red: 0.783383, green: 0.2625, blue: 0.483918 },
    { position: 0.490196, red: 0.787133, green: 0.266922, blue: 0.480307 },
    { position: 0.494118, red: 0.790855, green: 0.271345, blue: 0.476706 },
    { position: 0.498039, red: 0.794549, green: 0.27577, blue: 0.473117 },
    { position: 0.501961, red: 0.798216, green: 0.280197, blue: 0.469538 },
    { position: 0.505882, red: 0.801855, green: 0.284626, blue: 0.465971 },
    { position: 0.509804, red: 0.805467, green: 0.289057, blue: 0.462415 },
    { position: 0.513725, red: 0.809052, green: 0.293491, blue: 0.45887 },
    { position: 0.517647, red: 0.812612, green: 0.297928, blue: 0.455338 },
    { position: 0.521569, red: 0.816144, green: 0.302368, blue: 0.451816 },
    { position: 0.52549, red: 0.819651, green: 0.306812, blue: 0.448306 },
    { position: 0.529412, red: 0.823132, green: 0.311261, blue: 0.444806 },
    { position: 0.533333, red: 0.826588, green: 0.315714, blue: 0.441316 },
    { position: 0.537255, red: 0.830018, green: 0.320172, blue: 0.437836 },
    { position: 0.541176, red: 0.833422, green: 0.324635, blue: 0.434366 },
    { position: 0.545098, red: 0.836801, green: 0.329105, blue: 0.430905 },
    { position: 0.54902, red: 0.840155, green: 0.33358, blue: 0.427455 },
    { position: 0.552941, red: 0.843484, green: 0.338062, blue: 0.424013 },
    { position: 0.556863, red: 0.846788, green: 0.342551, blue: 0.420579 },
    { position: 0.560784, red: 0.850066, green: 0.347048, blue: 0.417153 },
    { position: 0.564706, red: 0.853319, green: 0.351553, blue: 0.413734 },
    { position: 0.568627, red: 0.856547, green: 0.356066, blue: 0.410322 },
    { position: 0.572549, red: 0.85975, green: 0.360588, blue: 0.406917 },
    { position: 0.576471, red: 0.862927, green: 0.365119, blue: 0.403519 },
    { position: 0.580392, red: 0.866078, green: 0.36966, blue: 0.400126 },
    { position: 0.584314, red: 0.869203, green: 0.374212, blue: 0.396738 },
    { position: 0.588235, red: 0.872303, green: 0.378774, blue: 0.393355 },
    { position: 0.592157, red: 0.875376, green: 0.383347, blue: 0.389976 },
    { position: 0.596078, red: 0.878423, green: 0.387932, blue: 0.3866 },
    { position: 0.6, red: 0.881443, green: 0.392529, blue: 0.383229 },
    { position: 0.603922, red: 0.884436, green: 0.397139, blue: 0.37986 },
    { position: 0.607843, red: 0.887402, green: 0.401762, blue: 0.376494 },
    { position: 0.611765, red: 0.89034, green: 0.406398, blue: 0.37313 },
    { position: 0.615686, red: 0.89325, green: 0.411048, blue: 0.369768 },
    { position: 0.619608, red: 0.896131, green: 0.415712, blue: 0.366407 },
    { position: 0.623529, red: 0.898984, green: 0.420392, blue: 0.363047 },
    { position: 0.627451, red: 0.901807, green: 0.425087, blue: 0.359688 },
    { position: 0.631373, red: 0.904601, green: 0.429797, blue: 0.356329 },
    { position: 0.635294, red: 0.907365, green: 0.434524, blue: 0.35297 },
    { position: 0.639216, red: 0.910098, green: 0.439268, blue: 0.34961 },
    { position: 0.643137, red: 0.9128, green: 0.444029, blue: 0.346251 },
    { position: 0.647059, red: 0.915471, green: 0.448807, blue: 0.34289 },
    { position: 0.65098, red: 0.918109, green: 0.453603, blue: 0.339529 },
    { position: 0.654902, red: 0.920714, green: 0.458417, blue: 0.336166 },
    { position: 0.658824, red: 0.923287, green: 0.463251, blue: 0.332801 },
    { position: 0.662745, red: 0.925825, green: 0.468103, blue: 0.329435 },
    { position: 0.666667, red: 0.928329, green: 0.472975, blue: 0.326067 },
    { position: 0.670588, red: 0.930798, green: 0.477867, blue: 0.322697 },
    { position: 0.67451, red: 0.933232, green: 0.48278, blue: 0.319325 },
    { position: 0.678431, red: 0.93563, green: 0.487712, blue: 0.315952 },
    { position: 0.682353, red: 0.93799, green: 0.492667, blue: 0.312575 },
    { position: 0.686275, red: 0.940313, green: 0.497642, blue: 0.309197 },
    { position: 0.690196, red: 0.942598, green: 0.502639, blue: 0.305816 },
    { position: 0.694118, red: 0.944844, green: 0.507658, blue: 0.302433 },
    { position: 0.698039, red: 0.947051, green: 0.512699, blue: 0.299049 },
    { position: 0.701961, red: 0.949217, green: 0.517763, blue: 0.295662 },
    { position: 0.705882, red: 0.951344, green: 0.52285, blue: 0.292275 },
    { position: 0.709804, red: 0.953428, green: 0.52796, blue: 0.288883 },
    { position: 0.713725, red: 0.95547, green: 0.533093, blue: 0.28549 },
    { position: 0.717647, red: 0.957469, green: 0.53825, blue: 0.282096 },
    { position: 0.721569, red: 0.959424, green: 0.543431, blue: 0.278701 },
    { position: 0.72549, red: 0.961336, green: 0.548636, blue: 0.275305 },
    { position: 0.729412, red: 0.963203, green: 0.553865, blue: 0.271909 },
    { position: 0.733333, red: 0.965024, green: 0.559118, blue: 0.268513 },
    { position: 0.737255, red: 0.966798, green: 0.564396, blue: 0.265118 },
    { position: 0.741176, red: 0.968526, green: 0.5697, blue: 0.261721 },
    { position: 0.745098, red: 0.970205, green: 0.575028, blue: 0.258325 },
    { position: 0.74902, red: 0.971835, green: 0.580382, blue: 0.254931 },
    { position: 0.752941, red: 0.973416, green: 0.585761, blue: 0.25154 },
    { position: 0.756863, red: 0.974947, green: 0.591165, blue: 0.248151 },
    { position: 0.760784, red: 0.976428, green: 0.596595, blue: 0.244767 },
    { position: 0.764706, red: 0.977856, green: 0.602051, blue: 0.241387 },
    { position: 0.768627, red: 0.979233, green: 0.607532, blue: 0.238013 },
    { position: 0.772549, red: 0.980556, green: 0.613039, blue: 0.234646 },
    { position: 0.776471, red: 0.981826, green: 0.618572, blue: 0.231287 },
    { position: 0.780392, red: 0.983041, green: 0.624131, blue: 0.227937 },
    { position: 0.784314, red: 0.984199, green: 0.629718, blue: 0.224595 },
    { position: 0.788235, red: 0.985301, green: 0.63533, blue: 0.221265 },
    { position: 0.792157, red: 0.986345, green: 0.640969, blue: 0.217948 },
    { position: 0.796078, red: 0.987332, green: 0.646633, blue: 0.214648 },
    { position: 0.8, red: 0.98826, green: 0.652325, blue: 0.211364 },
    { position: 0.803922, red: 0.989128, green: 0.658043, blue: 0.2081 },
    { position: 0.807843, red: 0.989935, green: 0.663787, blue: 0.204859 },
    { position: 0.811765, red: 0.990681, green: 0.669558, blue: 0.201642 },
    { position: 0.815686, red: 0.991365, green: 0.675355, blue: 0.198453 },
    { position: 0.819608, red: 0.991985, green: 0.681179, blue: 0.195295 },
    { position: 0.823529, red: 0.992541, green: 0.68703, blue: 0.19217 },
    { position: 0.827451, red: 0.993032, green: 0.692907, blue: 0.189084 },
    { position: 0.831373, red: 0.993456, green: 0.69881, blue: 0.186041 },
    { position: 0.835294, red: 0.993814, green: 0.704741, blue: 0.183043 },
    { position: 0.839216, red: 0.994103, green: 0.710698, blue: 0.180097 },
    { position: 0.843137, red: 0.994324, green: 0.716681, blue: 0.177208 },
    { position: 0.847059, red: 0.994474, green: 0.722691, blue: 0.174381 },
    { position: 0.85098, red: 0.994553, green: 0.728728, blue: 0.171622 },
    { position: 0.854902, red: 0.994561, green: 0.734791, blue: 0.168938 },
    { position: 0.858824, red: 0.994495, green: 0.74088, blue: 0.166335 },
    { position: 0.862745, red: 0.994355, green: 0.746995, blue: 0.163821 },
    { position: 0.866667, red: 0.994141, green: 0.753137, blue: 0.161404 },
    { position: 0.870588, red: 0.993851, green: 0.759304, blue: 0.159092 },
    { position: 0.87451, red: 0.993482, green: 0.765499, blue: 0.156891 },
    { position: 0.878431, red: 0.993033, green: 0.77172, blue: 0.154808 },
    { position: 0.882353, red: 0.992505, green: 0.777967, blue: 0.152855 },
    { position: 0.886275, red: 0.991897, green: 0.784239, blue: 0.151042 },
    { position: 0.890196, red: 0.991209, green: 0.790537, blue: 0.149377 },
    { position: 0.894118, red: 0.990439, green: 0.796859, blue: 0.14787 },
    { position: 0.898039, red: 0.989587, green: 0.803205, blue: 0.146529 },
    { position: 0.901961, red: 0.988648, green: 0.809579, blue: 0.145357 },
    { position: 0.905882, red: 0.987621, green: 0.815978, blue: 0.144363 },
    { position: 0.909804, red: 0.986509, green: 0.822401, blue: 0.143557 },
    { position: 0.913725, red: 0.985314, green: 0.828846, blue: 0.142945 },
    { position: 0.917647, red: 0.984031, green: 0.835315, blue: 0.142528 },
    { position: 0.921569, red: 0.982653, green: 0.841812, blue: 0.142303 },
    { position: 0.92549, red: 0.98119, green: 0.848329, blue: 0.142279 },
    { position: 0.929412, red: 0.979644, green: 0.854866, blue: 0.142453 },
    { position: 0.933333, red: 0.977995, green: 0.861432, blue: 0.142808 },
    { position: 0.937255, red: 0.976265, green: 0.868016, blue: 0.143351 },
    { position: 0.941176, red: 0.974443, green: 0.874622, blue: 0.144061 },
    { position: 0.945098, red: 0.97253, green: 0.88125, blue: 0.144923 },
    { position: 0.94902, red: 0.970533, green: 0.887896, blue: 0.145919 },
    { position: 0.952941, red: 0.968443, green: 0.894564, blue: 0.147014 },
    { position: 0.956863, red: 0.966271, green: 0.901249, blue: 0.14818 },
    { position: 0.960784, red: 0.964021, green: 0.90795, blue: 0.14937 },
    { position: 0.964706, red: 0.961681, green: 0.914672, blue: 0.15052 },
    { position: 0.968627, red: 0.959276, green: 0.921407, blue: 0.151566 },
    { position: 0.972549, red: 0.956808, green: 0.928152, blue: 0.152409 },
    { position: 0.976471, red: 0.954287, green: 0.934908, blue: 0.152921 },
    { position: 0.980392, red: 0.951726, green: 0.941671, blue: 0.152925 },
    { position: 0.984314, red: 0.949151, green: 0.948435, blue: 0.152178 },
    { position: 0.988235, red: 0.946602, green: 0.95519, blue: 0.150328 },
    { position: 0.992157, red: 0.944152, green: 0.961916, blue: 0.146861 },
    { position: 0.996078, red: 0.941896, green: 0.96859, blue: 0.140956 },
    { position: 1.0, red: 0.940015, green: 0.975158, blue: 0.131326 }
];

const PLASMA_DEF: ColormapDefinition = {
    name: 'Plasma',
    paraviewPreset: 'Plasma',
    colorSpace: 'Lab',
    nanColor: [0, 1, 0] as const,
    stops: PLASMA_STOPS
};

const VIRIDIS_STOPS: readonly ColormapStop[] = [
    { position: 0.0, red: 0.267004, green: 0.004874, blue: 0.329415 },
    { position: 0.003922, red: 0.26851, green: 0.009605, blue: 0.335427 },
    { position: 0.007843, red: 0.269944, green: 0.014625, blue: 0.341379 },
    { position: 0.011765, red: 0.271305, green: 0.019942, blue: 0.347269 },
    { position: 0.015686, red: 0.272594, green: 0.025563, blue: 0.353093 },
    { position: 0.019608, red: 0.273809, green: 0.031497, blue: 0.358853 },
    { position: 0.023529, red: 0.274952, green: 0.037752, blue: 0.364543 },
    { position: 0.027451, red: 0.276022, green: 0.044167, blue: 0.370164 },
    { position: 0.031373, red: 0.277018, green: 0.050344, blue: 0.375715 },
    { position: 0.035294, red: 0.277941, green: 0.056324, blue: 0.381191 },
    { position: 0.039216, red: 0.278791, green: 0.062145, blue: 0.386592 },
    { position: 0.043137, red: 0.279566, green: 0.067836, blue: 0.391917 },
    { position: 0.047059, red: 0.280267, green: 0.073417, blue: 0.397163 },
    { position: 0.05098, red: 0.280894, green: 0.078907, blue: 0.402329 },
    { position: 0.054902, red: 0.281446, green: 0.08432, blue: 0.407414 },
    { position: 0.058824, red: 0.281924, green: 0.089666, blue: 0.412415 },
    { position: 0.062745, red: 0.282327, green: 0.094955, blue: 0.417331 },
    { position: 0.066667, red: 0.282656, green: 0.100196, blue: 0.42216 },
    { position: 0.070588, red: 0.28291, green: 0.105393, blue: 0.426902 },
    { position: 0.07451, red: 0.283091, green: 0.110553, blue: 0.431554 },
    { position: 0.078431, red: 0.283197, green: 0.11568, blue: 0.436115 },
    { position: 0.082353, red: 0.283229, green: 0.120777, blue: 0.440584 },
    { position: 0.086275, red: 0.283187, green: 0.125848, blue: 0.44496 },
    { position: 0.090196, red: 0.283072, green: 0.130895, blue: 0.449241 },
    { position: 0.094118, red: 0.282884, green: 0.13592, blue: 0.453427 },
    { position: 0.098039, red: 0.282623, green: 0.140926, blue: 0.457517 },
    { position: 0.101961, red: 0.28229, green: 0.145912, blue: 0.46151 },
    { position: 0.105882, red: 0.281887, green: 0.150881, blue: 0.465405 },
    { position: 0.109804, red: 0.281412, green: 0.155834, blue: 0.469201 },
    { position: 0.113725, red: 0.280868, green: 0.160771, blue: 0.472899 },
    { position: 0.117647, red: 0.280255, green: 0.165693, blue: 0.476498 },
    { position: 0.121569, red: 0.279574, green: 0.170599, blue: 0.479997 },
    { position: 0.12549, red: 0.278826, green: 0.17549, blue: 0.483397 },
    { position: 0.129412, red: 0.278012, green: 0.180367, blue: 0.486697 },
    { position: 0.133333, red: 0.277134, green: 0.185228, blue: 0.489898 },
    { position: 0.137255, red: 0.276194, green: 0.190074, blue: 0.493001 },
    { position: 0.141176, red: 0.275191, green: 0.194905, blue: 0.496005 },
    { position: 0.145098, red: 0.274128, green: 0.199721, blue: 0.498911 },
    { position: 0.14902, red: 0.273006, green: 0.20452, blue: 0.501721 },
    { position: 0.152941, red: 0.271828, green: 0.209303, blue: 0.504434 },
    { position: 0.156863, red: 0.270595, green: 0.214069, blue: 0.507052 },
    { position: 0.160784, red: 0.269308, green: 0.218818, blue: 0.509577 },
    { position: 0.164706, red: 0.267968, green: 0.223549, blue: 0.512008 },
    { position: 0.168627, red: 0.26658, green: 0.228262, blue: 0.514349 },
    { position: 0.172549, red: 0.265145, green: 0.232956, blue: 0.516599 },
    { position: 0.176471, red: 0.263663, green: 0.237631, blue: 0.518762 },
    { position: 0.180392, red: 0.262138, green: 0.242286, blue: 0.520837 },
    { position: 0.184314, red: 0.260571, green: 0.246922, blue: 0.522828 },
    { position: 0.188235, red: 0.258965, green: 0.251537, blue: 0.524736 },
    { position: 0.192157, red: 0.257322, green: 0.25613, blue: 0.526563 },
    { position: 0.196078, red: 0.255645, green: 0.260703, blue: 0.528312 },
    { position: 0.2, red: 0.253935, green: 0.265254, blue: 0.529983 },
    { position: 0.203922, red: 0.252194, green: 0.269783, blue: 0.531579 },
    { position: 0.207843, red: 0.250425, green: 0.27429, blue: 0.533103 },
    { position: 0.211765, red: 0.248629, green: 0.278775, blue: 0.534556 },
    { position: 0.215686, red: 0.246811, green: 0.283237, blue: 0.535941 },
    { position: 0.219608, red: 0.244972, green: 0.287675, blue: 0.53726 },
    { position: 0.223529, red: 0.243113, green: 0.292092, blue: 0.538516 },
    { position: 0.227451, red: 0.241237, green: 0.296485, blue: 0.539709 },
    { position: 0.231373, red: 0.239346, green: 0.300855, blue: 0.540844 },
    { position: 0.235294, red: 0.237441, green: 0.305202, blue: 0.541921 },
    { position: 0.239216, red: 0.235526, green: 0.309527, blue: 0.542944 },
    { position: 0.243137, red: 0.233603, green: 0.313828, blue: 0.543914 },
    { position: 0.247059, red: 0.231674, green: 0.318106, blue: 0.544834 },
    { position: 0.25098, red: 0.229739, green: 0.322361, blue: 0.545706 },
    { position: 0.254902, red: 0.227802, green: 0.326594, blue: 0.546532 },
    { position: 0.258824, red: 0.225863, green: 0.330805, blue: 0.547314 },
    { position: 0.262745, red: 0.223925, green: 0.334994, blue: 0.548053 },
    { position: 0.266667, red: 0.221989, green: 0.339161, blue: 0.548752 },
    { position: 0.270588, red: 0.220057, green: 0.343307, blue: 0.549413 },
    { position: 0.27451, red: 0.21813, green: 0.347432, blue: 0.550038 },
    { position: 0.278431, red: 0.21621, green: 0.351535, blue: 0.550627 },
    { position: 0.282353, red: 0.214298, green: 0.355619, blue: 0.551184 },
    { position: 0.286275, red: 0.212395, green: 0.359683, blue: 0.55171 },
    { position: 0.290196, red: 0.210503, green: 0.363727, blue: 0.552206 },
    { position: 0.294118, red: 0.208623, green: 0.367752, blue: 0.552675 },
    { position: 0.298039, red: 0.206756, green: 0.371758, blue: 0.553117 },
    { position: 0.301961, red: 0.204903, green: 0.375746, blue: 0.553533 },
    { position: 0.305882, red: 0.203063, green: 0.379716, blue: 0.553925 },
    { position: 0.309804, red: 0.201239, green: 0.38367, blue: 0.554294 },
    { position: 0.313725, red: 0.19943, green: 0.387607, blue: 0.554642 },
    { position: 0.317647, red: 0.197636, green: 0.391528, blue: 0.554969 },
    { position: 0.321569, red: 0.19586, green: 0.395433, blue: 0.555276 },
    { position: 0.32549, red: 0.1941, green: 0.399323, blue: 0.555565 },
    { position: 0.329412, red: 0.192357, green: 0.403199, blue: 0.555836 },
    { position: 0.333333, red: 0.190631, green: 0.407061, blue: 0.556089 },
    { position: 0.337255, red: 0.188923, green: 0.41091, blue: 0.556326 },
    { position: 0.341176, red: 0.187231, green: 0.414746, blue: 0.556547 },
    { position: 0.345098, red: 0.185556, green: 0.41857, blue: 0.556753 },
    { position: 0.34902, red: 0.183898, green: 0.422383, blue: 0.556944 },
    { position: 0.352941, red: 0.182256, green: 0.426184, blue: 0.55712 },
    { position: 0.356863, red: 0.180629, green: 0.429975, blue: 0.557282 },
    { position: 0.360784, red: 0.179019, green: 0.433756, blue: 0.55743 },
    { position: 0.364706, red: 0.177423, green: 0.437527, blue: 0.557565 },
    { position: 0.368627, red: 0.175841, green: 0.44129, blue: 0.557685 },
    { position: 0.372549, red: 0.174274, green: 0.445044, blue: 0.557792 },
    { position: 0.376471, red: 0.172719, green: 0.448791, blue: 0.557885 },
    { position: 0.380392, red: 0.171176, green: 0.45253, blue: 0.557965 },
    { position: 0.384314, red: 0.169646, green: 0.456262, blue: 0.55803 },
    { position: 0.388235, red: 0.168126, green: 0.459988, blue: 0.558082 },
    { position: 0.392157, red: 0.166617, green: 0.463708, blue: 0.558119 },
    { position: 0.396078, red: 0.165117, green: 0.467423, blue: 0.558141 },
    { position: 0.4, red: 0.163625, green: 0.471133, blue: 0.558148 },
    { position: 0.403922, red: 0.162142, green: 0.474838, blue: 0.55814 },
    { position: 0.407843, red: 0.160665, green: 0.47854, blue: 0.558115 },
    { position: 0.411765, red: 0.159194, green: 0.482237, blue: 0.558073 },
    { position: 0.415686, red: 0.157729, green: 0.485932, blue: 0.558013 },
    { position: 0.419608, red: 0.15627, green: 0.489624, blue: 0.557936 },
    { position: 0.423529, red: 0.154815, green: 0.493313, blue: 0.55784 },
    { position: 0.427451, red: 0.153364, green: 0.497, blue: 0.557724 },
    { position: 0.431373, red: 0.151918, green: 0.500685, blue: 0.557587 },
    { position: 0.435294, red: 0.150476, green: 0.504369, blue: 0.55743 },
    { position: 0.439216, red: 0.149039, green: 0.508051, blue: 0.55725 },
    { position: 0.443137, red: 0.147607, green: 0.511733, blue: 0.557049 },
    { position: 0.447059, red: 0.14618, green: 0.515413, blue: 0.556823 },
    { position: 0.45098, red: 0.144759, green: 0.519093, blue: 0.556572 },
    { position: 0.454902, red: 0.143343, green: 0.522773, blue: 0.556295 },
    { position: 0.458824, red: 0.141935, green: 0.526453, blue: 0.555991 },
    { position: 0.462745, red: 0.140536, green: 0.530132, blue: 0.555659 },
    { position: 0.466667, red: 0.139147, green: 0.533812, blue: 0.555298 },
    { position: 0.470588, red: 0.13777, green: 0.537492, blue: 0.554906 },
    { position: 0.47451, red: 0.136408, green: 0.541173, blue: 0.554483 },
    { position: 0.478431, red: 0.135066, green: 0.544853, blue: 0.554029 },
    { position: 0.482353, red: 0.133743, green: 0.548535, blue: 0.553541 },
    { position: 0.486275, red: 0.132444, green: 0.552216, blue: 0.553018 },
    { position: 0.490196, red: 0.131172, green: 0.555899, blue: 0.552459 },
    { position: 0.494118, red: 0.129933, green: 0.559582, blue: 0.551864 },
    { position: 0.498039, red: 0.128729, green: 0.563265, blue: 0.551229 },
    { position: 0.501961, red: 0.127568, green: 0.566949, blue: 0.550556 },
    { position: 0.505882, red: 0.126453, green: 0.570633, blue: 0.549841 },
    { position: 0.509804, red: 0.125394, green: 0.574318, blue: 0.549086 },
    { position: 0.513725, red: 0.124395, green: 0.578002, blue: 0.548287 },
    { position: 0.517647, red: 0.123463, green: 0.581687, blue: 0.547445 },
    { position: 0.521569, red: 0.122606, green: 0.585371, blue: 0.546557 },
    { position: 0.52549, red: 0.121831, green: 0.589055, blue: 0.545623 },
    { position: 0.529412, red: 0.121148, green: 0.592739, blue: 0.544641 },
    { position: 0.533333, red: 0.120565, green: 0.596422, blue: 0.543611 },
    { position: 0.537255, red: 0.120092, green: 0.600104, blue: 0.54253 },
    { position: 0.541176, red: 0.119738, green: 0.603785, blue: 0.5414 },
    { position: 0.545098, red: 0.119512, green: 0.607464, blue: 0.540218 },
    { position: 0.54902, red: 0.119423, green: 0.611141, blue: 0.538982 },
    { position: 0.552941, red: 0.119483, green: 0.614817, blue: 0.537692 },
    { position: 0.556863, red: 0.119699, green: 0.61849, blue: 0.536347 },
    { position: 0.560784, red: 0.120081, green: 0.622161, blue: 0.534946 },
    { position: 0.564706, red: 0.120638, green: 0.625828, blue: 0.533488 },
    { position: 0.568627, red: 0.12138, green: 0.629492, blue: 0.531973 },
    { position: 0.572549, red: 0.122312, green: 0.633153, blue: 0.530398 },
    { position: 0.576471, red: 0.123444, green: 0.636809, blue: 0.528763 },
    { position: 0.580392, red: 0.12478, green: 0.640461, blue: 0.527068 },
    { position: 0.584314, red: 0.126326, green: 0.644107, blue: 0.525311 },
    { position: 0.588235, red: 0.128087, green: 0.647749, blue: 0.523491 },
    { position: 0.592157, red: 0.130067, green: 0.651384, blue: 0.521608 },
    { position: 0.596078, red: 0.132268, green: 0.655014, blue: 0.519661 },
    { position: 0.6, red: 0.134692, green: 0.658636, blue: 0.517649 },
    { position: 0.603922, red: 0.137339, green: 0.662252, blue: 0.515571 },
    { position: 0.607843, red: 0.14021, green: 0.665859, blue: 0.513427 },
    { position: 0.611765, red: 0.143303, green: 0.669459, blue: 0.511215 },
    { position: 0.615686, red: 0.146616, green: 0.67305, blue: 0.508936 },
    { position: 0.619608, red: 0.150148, green: 0.676631, blue: 0.506589 },
    { position: 0.623529, red: 0.153894, green: 0.680203, blue: 0.504172 },
    { position: 0.627451, red: 0.157851, green: 0.683765, blue: 0.501686 },
    { position: 0.631373, red: 0.162016, green: 0.687316, blue: 0.499129 },
    { position: 0.635294, red: 0.166383, green: 0.690856, blue: 0.496502 },
    { position: 0.639216, red: 0.170948, green: 0.694384, blue: 0.493803 },
    { position: 0.643137, red: 0.175707, green: 0.6979, blue: 0.491033 },
    { position: 0.647059, red: 0.180653, green: 0.701402, blue: 0.488189 },
    { position: 0.65098, red: 0.185783, green: 0.704891, blue: 0.485273 },
    { position: 0.654902, red: 0.19109, green: 0.708366, blue: 0.482284 },
    { position: 0.658824, red: 0.196571, green: 0.711827, blue: 0.479221 },
    { position: 0.662745, red: 0.202219, green: 0.715272, blue: 0.476084 },
    { position: 0.666667, red: 0.20803, green: 0.718701, blue: 0.472873 },
    { position: 0.670588, red: 0.214, green: 0.722114, blue: 0.469588 },
    { position: 0.67451, red: 0.220124, green: 0.725509, blue: 0.466226 },
    { position: 0.678431, red: 0.226397, green: 0.728888, blue: 0.462789 },
    { position: 0.682353, red: 0.232815, green: 0.732247, blue: 0.459277 },
    { position: 0.686275, red: 0.239374, green: 0.735588, blue: 0.455688 },
    { position: 0.690196, red: 0.24607, green: 0.73891, blue: 0.452024 },
    { position: 0.694118, red: 0.252899, green: 0.742211, blue: 0.448284 },
    { position: 0.698039, red: 0.259857, green: 0.745492, blue: 0.444467 },
    { position: 0.701961, red: 0.266941, green: 0.748751, blue: 0.440573 },
    { position: 0.705882, red: 0.274149, green: 0.751988, blue: 0.436601 },
    { position: 0.709804, red: 0.281477, green: 0.755203, blue: 0.432552 },
    { position: 0.713725, red: 0.288921, green: 0.758394, blue: 0.428426 },
    { position: 0.717647, red: 0.296479, green: 0.761561, blue: 0.424223 },
    { position: 0.721569, red: 0.304148, green: 0.764704, blue: 0.419943 },
    { position: 0.72549, red: 0.311925, green: 0.767822, blue: 0.415586 },
    { position: 0.729412, red: 0.319809, green: 0.770914, blue: 0.411152 },
    { position: 0.733333, red: 0.327796, green: 0.77398, blue: 0.40664 },
    { position: 0.737255, red: 0.335885, green: 0.777018, blue: 0.402049 },
    { position: 0.741176, red: 0.344074, green: 0.780029, blue: 0.397381 },
    { position: 0.745098, red: 0.35236, green: 0.783011, blue: 0.392636 },
    { position: 0.74902, red: 0.360741, green: 0.785964, blue: 0.387814 },
    { position: 0.752941, red: 0.369214, green: 0.788888, blue: 0.382914 },
    { position: 0.756863, red: 0.377779, green: 0.791781, blue: 0.377939 },
    { position: 0.760784, red: 0.386433, green: 0.794644, blue: 0.372886 },
    { position: 0.764706, red: 0.395174, green: 0.797475, blue: 0.367757 },
    { position: 0.768627, red: 0.404001, green: 0.800275, blue: 0.362552 },
    { position: 0.772549, red: 0.412913, green: 0.803041, blue: 0.357269 },
    { position: 0.776471, red: 0.421908, green: 0.805774, blue: 0.35191 },
    { position: 0.780392, red: 0.430983, green: 0.808473, blue: 0.346476 },
    { position: 0.784314, red: 0.440137, green: 0.811138, blue: 0.340967 },
    { position: 0.788235, red: 0.449368, green: 0.813768, blue: 0.335384 },
    { position: 0.792157, red: 0.458674, green: 0.816363, blue: 0.329727 },
    { position: 0.796078, red: 0.468053, green: 0.818921, blue: 0.323998 },
    { position: 0.8, red: 0.477504, green: 0.821444, blue: 0.318195 },
    { position: 0.803922, red: 0.487026, green: 0.823929, blue: 0.312321 },
    { position: 0.807843, red: 0.496615, green: 0.826376, blue: 0.306377 },
    { position: 0.811765, red: 0.506271, green: 0.828786, blue: 0.300362 },
    { position: 0.815686, red: 0.515992, green: 0.831158, blue: 0.294279 },
    { position: 0.819608, red: 0.525776, green: 0.833491, blue: 0.288127 },
    { position: 0.823529, red: 0.535621, green: 0.835785, blue: 0.281908 },
    { position: 0.827451, red: 0.545524, green: 0.838039, blue: 0.275626 },
    { position: 0.831373, red: 0.555484, green: 0.840254, blue: 0.269281 },
    { position: 0.835294, red: 0.565498, green: 0.84243, blue: 0.262877 },
    { position: 0.839216, red: 0.575563, green: 0.844566, blue: 0.256415 },
    { position: 0.843137, red: 0.585678, green: 0.846661, blue: 0.249897 },
    { position: 0.847059, red: 0.595839, green: 0.848717, blue: 0.243329 },
    { position: 0.85098, red: 0.606045, green: 0.850733, blue: 0.236712 },
    { position: 0.854902, red: 0.616293, green: 0.852709, blue: 0.230052 },
    { position: 0.858824, red: 0.626579, green: 0.854645, blue: 0.223353 },
    { position: 0.862745, red: 0.636902, green: 0.856542, blue: 0.21662 },
    { position: 0.866667, red: 0.647257, green: 0.8584, blue: 0.209861 },
    { position: 0.870588, red: 0.657642, green: 0.860219, blue: 0.203082 },
    { position: 0.87451, red: 0.668054, green: 0.861999, blue: 0.196293 },
    { position: 0.878431, red: 0.678489, green: 0.863742, blue: 0.189503 },
    { position: 0.882353, red: 0.688944, green: 0.865448, blue: 0.182725 },
    { position: 0.886275, red: 0.699415, green: 0.867117, blue: 0.175971 },
    { position: 0.890196, red: 0.709898, green: 0.868751, blue: 0.169257 },
    { position: 0.894118, red: 0.720391, green: 0.87035, blue: 0.162603 },
    { position: 0.898039, red: 0.730889, green: 0.871916, blue: 0.156029 },
    { position: 0.901961, red: 0.741388, green: 0.873449, blue: 0.149561 },
    { position: 0.905882, red: 0.751884, green: 0.874951, blue: 0.143228 },
    { position: 0.909804, red: 0.762373, green: 0.876424, blue: 0.137064 },
    { position: 0.913725, red: 0.772852, green: 0.877868, blue: 0.131109 },
    { position: 0.917647, red: 0.783315, green: 0.879285, blue: 0.125405 },
    { position: 0.921569, red: 0.79376, green: 0.880678, blue: 0.120005 },
    { position: 0.92549, red: 0.804182, green: 0.882046, blue: 0.114965 },
    { position: 0.929412, red: 0.814576, green: 0.883393, blue: 0.110347 },
    { position: 0.933333, red: 0.82494, green: 0.88472, blue: 0.106217 },
    { position: 0.937255, red: 0.83527, green: 0.886029, blue: 0.102646 },
    { position: 0.941176, red: 0.845561, green: 0.887322, blue: 0.099702 },
    { position: 0.945098, red: 0.85581, green: 0.888601, blue: 0.097452 },
    { position: 0.94902, red: 0.866013, green: 0.889868, blue: 0.095953 },
    { position: 0.952941, red: 0.876168, green: 0.891125, blue: 0.09525 },
    { position: 0.956863, red: 0.886271, green: 0.892374, blue: 0.095374 },
    { position: 0.960784, red: 0.89632, green: 0.893616, blue: 0.096335 },
    { position: 0.964706, red: 0.906311, green: 0.894855, blue: 0.098125 },
    { position: 0.968627, red: 0.916242, green: 0.896091, blue: 0.100717 },
    { position: 0.972549, red: 0.926106, green: 0.89733, blue: 0.104071 },
    { position: 0.976471, red: 0.935904, green: 0.89857, blue: 0.108131 },
    { position: 0.980392, red: 0.945636, green: 0.899815, blue: 0.112838 },
    { position: 0.984314, red: 0.9553, green: 0.901065, blue: 0.118128 },
    { position: 0.988235, red: 0.964894, green: 0.902323, blue: 0.123941 },
    { position: 0.992157, red: 0.974417, green: 0.90359, blue: 0.130215 },
    { position: 0.996078, red: 0.983868, green: 0.904867, blue: 0.136897 },
    { position: 1.0, red: 0.993248, green: 0.906157, blue: 0.143936 }
];

const VIRIDIS_DEF: ColormapDefinition = {
    name: 'Viridis',
    paraviewPreset: 'Viridis',
    colorSpace: 'Lab',
    nanColor: [1, 0, 0] as const,
    stops: VIRIDIS_STOPS
};

const INFERNO_STOPS: readonly ColormapStop[] = [
    { position: 0.0, red: 0.001462, green: 0.000466, blue: 0.013866 },
    { position: 0.003922, red: 0.002267, green: 0.00127, blue: 0.01857 },
    { position: 0.007843, red: 0.003299, green: 0.002249, blue: 0.024239 },
    { position: 0.011765, red: 0.004547, green: 0.003392, blue: 0.030909 },
    { position: 0.015686, red: 0.006006, green: 0.004692, blue: 0.038558 },
    { position: 0.019608, red: 0.007676, green: 0.006136, blue: 0.046836 },
    { position: 0.023529, red: 0.009561, green: 0.007713, blue: 0.055143 },
    { position: 0.027451, red: 0.011663, green: 0.009417, blue: 0.06346 },
    { position: 0.031373, red: 0.013995, green: 0.011225, blue: 0.071862 },
    { position: 0.035294, red: 0.016561, green: 0.013136, blue: 0.080282 },
    { position: 0.039216, red: 0.019373, green: 0.015133, blue: 0.088767 },
    { position: 0.043137, red: 0.022447, green: 0.017199, blue: 0.097327 },
    { position: 0.047059, red: 0.025793, green: 0.019331, blue: 0.10593 },
    { position: 0.05098, red: 0.029432, green: 0.021503, blue: 0.114621 },
    { position: 0.054902, red: 0.033385, green: 0.023702, blue: 0.123397 },
    { position: 0.058824, red: 0.037668, green: 0.025921, blue: 0.132232 },
    { position: 0.062745, red: 0.042253, green: 0.028139, blue: 0.141141 },
    { position: 0.066667, red: 0.046915, green: 0.030324, blue: 0.150164 },
    { position: 0.070588, red: 0.051644, green: 0.032474, blue: 0.159254 },
    { position: 0.07451, red: 0.056449, green: 0.034569, blue: 0.168414 },
    { position: 0.078431, red: 0.06134, green: 0.03659, blue: 0.177642 },
    { position: 0.082353, red: 0.066331, green: 0.038504, blue: 0.186962 },
    { position: 0.086275, red: 0.071429, green: 0.040294, blue: 0.196354 },
    { position: 0.090196, red: 0.076637, green: 0.041905, blue: 0.205799 },
    { position: 0.094118, red: 0.081962, green: 0.043328, blue: 0.215289 },
    { position: 0.098039, red: 0.087411, green: 0.044556, blue: 0.224813 },
    { position: 0.101961, red: 0.09299, green: 0.045583, blue: 0.234358 },
    { position: 0.105882, red: 0.098702, green: 0.046402, blue: 0.243904 },
    { position: 0.109804, red: 0.104551, green: 0.047008, blue: 0.25343 },
    { position: 0.113725, red: 0.110536, green: 0.047399, blue: 0.262912 },
    { position: 0.117647, red: 0.116656, green: 0.047574, blue: 0.272321 },
    { position: 0.121569, red: 0.122908, green: 0.047536, blue: 0.281624 },
    { position: 0.12549, red: 0.129285, green: 0.047293, blue: 0.290788 },
    { position: 0.129412, red: 0.135778, green: 0.046856, blue: 0.299776 },
    { position: 0.133333, red: 0.142378, green: 0.046242, blue: 0.308553 },
    { position: 0.137255, red: 0.149073, green: 0.045468, blue: 0.317085 },
    { position: 0.141176, red: 0.15585, green: 0.044559, blue: 0.325338 },
    { position: 0.145098, red: 0.162689, green: 0.043554, blue: 0.333277 },
    { position: 0.14902, red: 0.169575, green: 0.042489, blue: 0.340874 },
    { position: 0.152941, red: 0.176493, green: 0.041402, blue: 0.348111 },
    { position: 0.156863, red: 0.183429, green: 0.040329, blue: 0.354971 },
    { position: 0.160784, red: 0.190367, green: 0.039309, blue: 0.361447 },
    { position: 0.164706, red: 0.197297, green: 0.0384, blue: 0.367535 },
    { position: 0.168627, red: 0.204209, green: 0.037632, blue: 0.373238 },
    { position: 0.172549, red: 0.211095, green: 0.03703, blue: 0.378563 },
    { position: 0.176471, red: 0.217949, green: 0.036615, blue: 0.383522 },
    { position: 0.180392, red: 0.224763, green: 0.036405, blue: 0.388129 },
    { position: 0.184314, red: 0.231538, green: 0.036405, blue: 0.3924 },
    { position: 0.188235, red: 0.238273, green: 0.036621, blue: 0.396353 },
    { position: 0.192157, red: 0.244967, green: 0.037055, blue: 0.400007 },
    { position: 0.196078, red: 0.25162, green: 0.037705, blue: 0.403378 },
    { position: 0.2, red: 0.258234, green: 0.038571, blue: 0.406485 },
    { position: 0.203922, red: 0.26481, green: 0.039647, blue: 0.409345 },
    { position: 0.207843, red: 0.271347, green: 0.040922, blue: 0.411976 },
    { position: 0.211765, red: 0.27785, green: 0.042353, blue: 0.414392 },
    { position: 0.215686, red: 0.284321, green: 0.043933, blue: 0.416608 },
    { position: 0.219608, red: 0.290763, green: 0.045644, blue: 0.418637 },
    { position: 0.223529, red: 0.297178, green: 0.04747, blue: 0.420491 },
    { position: 0.227451, red: 0.303568, green: 0.049396, blue: 0.422182 },
    { position: 0.231373, red: 0.309935, green: 0.051407, blue: 0.423721 },
    { position: 0.235294, red: 0.316282, green: 0.05349, blue: 0.425116 },
    { position: 0.239216, red: 0.32261, green: 0.055634, blue: 0.426377 },
    { position: 0.243137, red: 0.328921, green: 0.057827, blue: 0.427511 },
    { position: 0.247059, red: 0.335217, green: 0.06006, blue: 0.428524 },
    { position: 0.25098, red: 0.3415, green: 0.062325, blue: 0.429425 },
    { position: 0.254902, red: 0.347771, green: 0.064616, blue: 0.430217 },
    { position: 0.258824, red: 0.354032, green: 0.066925, blue: 0.430906 },
    { position: 0.262745, red: 0.360284, green: 0.069247, blue: 0.431497 },
    { position: 0.266667, red: 0.366529, green: 0.071579, blue: 0.431994 },
    { position: 0.270588, red: 0.372768, green: 0.073915, blue: 0.4324 },
    { position: 0.27451, red: 0.379001, green: 0.076253, blue: 0.432719 },
    { position: 0.278431, red: 0.385228, green: 0.078591, blue: 0.432955 },
    { position: 0.282353, red: 0.391453, green: 0.080927, blue: 0.433109 },
    { position: 0.286275, red: 0.397674, green: 0.083257, blue: 0.433183 },
    { position: 0.290196, red: 0.403894, green: 0.08558, blue: 0.433179 },
    { position: 0.294118, red: 0.410113, green: 0.087896, blue: 0.433098 },
    { position: 0.298039, red: 0.416331, green: 0.090203, blue: 0.432943 },
    { position: 0.301961, red: 0.422549, green: 0.092501, blue: 0.432714 },
    { position: 0.305882, red: 0.428768, green: 0.09479, blue: 0.432412 },
    { position: 0.309804, red: 0.434987, green: 0.097069, blue: 0.432039 },
    { position: 0.313725, red: 0.441207, green: 0.099338, blue: 0.431594 },
    { position: 0.317647, red: 0.447428, green: 0.101597, blue: 0.43108 },
    { position: 0.321569, red: 0.453651, green: 0.103848, blue: 0.430498 },
    { position: 0.32549, red: 0.459875, green: 0.106089, blue: 0.429846 },
    { position: 0.329412, red: 0.4661, green: 0.108322, blue: 0.429125 },
    { position: 0.333333, red: 0.472328, green: 0.110547, blue: 0.428334 },
    { position: 0.337255, red: 0.478558, green: 0.112764, blue: 0.427475 },
    { position: 0.341176, red: 0.484789, green: 0.114974, blue: 0.426548 },
    { position: 0.345098, red: 0.491022, green: 0.117179, blue: 0.425552 },
    { position: 0.34902, red: 0.497257, green: 0.119379, blue: 0.424488 },
    { position: 0.352941, red: 0.503493, green: 0.121575, blue: 0.423356 },
    { position: 0.356863, red: 0.50973, green: 0.123769, blue: 0.422156 },
    { position: 0.360784, red: 0.515967, green: 0.12596, blue: 0.420887 },
    { position: 0.364706, red: 0.522206, green: 0.12815, blue: 0.419549 },
    { position: 0.368627, red: 0.528444, green: 0.130341, blue: 0.418142 },
    { position: 0.372549, red: 0.534683, green: 0.132534, blue: 0.416667 },
    { position: 0.376471, red: 0.54092, green: 0.134729, blue: 0.415123 },
    { position: 0.380392, red: 0.547157, green: 0.136929, blue: 0.413511 },
    { position: 0.384314, red: 0.553392, green: 0.139134, blue: 0.411829 },
    { position: 0.388235, red: 0.559624, green: 0.141346, blue: 0.410078 },
    { position: 0.392157, red: 0.565854, green: 0.143567, blue: 0.408258 },
    { position: 0.396078, red: 0.572081, green: 0.145797, blue: 0.406369 },
    { position: 0.4, red: 0.578304, green: 0.148039, blue: 0.404411 },
    { position: 0.403922, red: 0.584521, green: 0.150294, blue: 0.402385 },
    { position: 0.407843, red: 0.590734, green: 0.152563, blue: 0.40029 },
    { position: 0.411765, red: 0.59694, green: 0.154848, blue: 0.398125 },
    { position: 0.415686, red: 0.603139, green: 0.157151, blue: 0.395891 },
    { position: 0.419608, red: 0.60933, green: 0.159474, blue: 0.393589 },
    { position: 0.423529, red: 0.615513, green: 0.161817, blue: 0.391219 },
    { position: 0.427451, red: 0.621685, green: 0.164184, blue: 0.388781 },
    { position: 0.431373, red: 0.627847, green: 0.166575, blue: 0.386276 },
    { position: 0.435294, red: 0.633998, green: 0.168992, blue: 0.383704 },
    { position: 0.439216, red: 0.640135, green: 0.171438, blue: 0.381065 },
    { position: 0.443137, red: 0.64626, green: 0.173914, blue: 0.378359 },
    { position: 0.447059, red: 0.652369, green: 0.176421, blue: 0.375586 },
    { position: 0.45098, red: 0.658463, green: 0.178962, blue: 0.372748 },
    { position: 0.454902, red: 0.66454, green: 0.181539, blue: 0.369846 },
    { position: 0.458824, red: 0.670599, green: 0.184153, blue: 0.366879 },
    { position: 0.462745, red: 0.676638, green: 0.186807, blue: 0.363849 },
    { position: 0.466667, red: 0.682656, green: 0.189501, blue: 0.360757 },
    { position: 0.470588, red: 0.688653, green: 0.192239, blue: 0.357603 },
    { position: 0.47451, red: 0.694627, green: 0.195021, blue: 0.354388 },
    { position: 0.478431, red: 0.700576, green: 0.197851, blue: 0.351113 },
    { position: 0.482353, red: 0.7065, green: 0.200728, blue: 0.347777 },
    { position: 0.486275, red: 0.712396, green: 0.203656, blue: 0.344383 },
    { position: 0.490196, red: 0.718264, green: 0.206636, blue: 0.340931 },
    { position: 0.494118, red: 0.724103, green: 0.20967, blue: 0.337424 },
    { position: 0.498039, red: 0.729909, green: 0.212759, blue: 0.333861 },
    { position: 0.501961, red: 0.735683, green: 0.215906, blue: 0.330245 },
    { position: 0.505882, red: 0.741423, green: 0.219112, blue: 0.326576 },
    { position: 0.509804, red: 0.747127, green: 0.222378, blue: 0.322856 },
    { position: 0.513725, red: 0.752794, green: 0.225706, blue: 0.319085 },
    { position: 0.517647, red: 0.758422, green: 0.229097, blue: 0.315266 },
    { position: 0.521569, red: 0.76401, green: 0.232554, blue: 0.311399 },
    { position: 0.52549, red: 0.769556, green: 0.236077, blue: 0.307485 },
    { position: 0.529412, red: 0.775059, green: 0.239667, blue: 0.303526 },
    { position: 0.533333, red: 0.780517, green: 0.243327, blue: 0.299523 },
    { position: 0.537255, red: 0.785929, green: 0.247056, blue: 0.295477 },
    { position: 0.541176, red: 0.791293, green: 0.250856, blue: 0.29139 },
    { position: 0.545098, red: 0.796607, green: 0.254728, blue: 0.287264 },
    { position: 0.54902, red: 0.801871, green: 0.258674, blue: 0.283099 },
    { position: 0.552941, red: 0.807082, green: 0.262692, blue: 0.278898 },
    { position: 0.556863, red: 0.812239, green: 0.266786, blue: 0.274661 },
    { position: 0.560784, red: 0.817341, green: 0.270954, blue: 0.27039 },
    { position: 0.564706, red: 0.822386, green: 0.275197, blue: 0.266085 },
    { position: 0.568627, red: 0.827372, green: 0.279517, blue: 0.26175 },
    { position: 0.572549, red: 0.832299, green: 0.283913, blue: 0.257383 },
    { position: 0.576471, red: 0.837165, green: 0.288385, blue: 0.252988 },
    { position: 0.580392, red: 0.841969, green: 0.292933, blue: 0.248564 },
    { position: 0.584314, red: 0.846709, green: 0.297559, blue: 0.244113 },
    { position: 0.588235, red: 0.851384, green: 0.30226, blue: 0.239636 },
    { position: 0.592157, red: 0.855992, green: 0.307038, blue: 0.235133 },
    { position: 0.596078, red: 0.860533, green: 0.311892, blue: 0.230606 },
    { position: 0.6, red: 0.865006, green: 0.316822, blue: 0.226055 },
    { position: 0.603922, red: 0.869409, green: 0.321827, blue: 0.221482 },
    { position: 0.607843, red: 0.873741, green: 0.326906, blue: 0.216886 },
    { position: 0.611765, red: 0.878001, green: 0.33206, blue: 0.212268 },
    { position: 0.615686, red: 0.882188, green: 0.337287, blue: 0.207628 },
    { position: 0.619608, red: 0.886302, green: 0.342586, blue: 0.202968 },
    { position: 0.623529, red: 0.890341, green: 0.347957, blue: 0.198286 },
    { position: 0.627451, red: 0.894305, green: 0.353399, blue: 0.193584 },
    { position: 0.631373, red: 0.898192, green: 0.358911, blue: 0.18886 },
    { position: 0.635294, red: 0.902003, green: 0.364492, blue: 0.184116 },
    { position: 0.639216, red: 0.905735, green: 0.37014, blue: 0.17935 },
    { position: 0.643137, red: 0.90939, green: 0.375856, blue: 0.174563 },
    { position: 0.647059, red: 0.912966, green: 0.381636, blue: 0.169755 },
    { position: 0.65098, red: 0.916462, green: 0.387481, blue: 0.164924 },
    { position: 0.654902, red: 0.919879, green: 0.393389, blue: 0.16007 },
    { position: 0.658824, red: 0.923215, green: 0.399359, blue: 0.155193 },
    { position: 0.662745, red: 0.92647, green: 0.405389, blue: 0.150292 },
    { position: 0.666667, red: 0.929644, green: 0.411479, blue: 0.145367 },
    { position: 0.670588, red: 0.932737, green: 0.417627, blue: 0.140417 },
    { position: 0.67451, red: 0.935747, green: 0.423831, blue: 0.13544 },
    { position: 0.678431, red: 0.938675, green: 0.430091, blue: 0.130438 },
    { position: 0.682353, red: 0.941521, green: 0.436405, blue: 0.125409 },
    { position: 0.686275, red: 0.944285, green: 0.442772, blue: 0.120354 },
    { position: 0.690196, red: 0.946965, green: 0.449191, blue: 0.115272 },
    { position: 0.694118, red: 0.949562, green: 0.45566, blue: 0.110164 },
    { position: 0.698039, red: 0.952075, green: 0.462178, blue: 0.105031 },
    { position: 0.701961, red: 0.954506, green: 0.468744, blue: 0.099874 },
    { position: 0.705882, red: 0.956852, green: 0.475356, blue: 0.094695 },
    { position: 0.709804, red: 0.959114, green: 0.482014, blue: 0.089499 },
    { position: 0.713725, red: 0.961293, green: 0.488716, blue: 0.084289 },
    { position: 0.717647, red: 0.963387, green: 0.495462, blue: 0.079073 },
    { position: 0.721569, red: 0.965397, green: 0.502249, blue: 0.073859 },
    { position: 0.72549, red: 0.967322, green: 0.509078, blue: 0.068659 },
    { position: 0.729412, red: 0.969163, green: 0.515946, blue: 0.063488 },
    { position: 0.733333, red: 0.970919, green: 0.522853, blue: 0.058367 },
    { position: 0.737255, red: 0.97259, green: 0.529798, blue: 0.053324 },
    { position: 0.741176, red: 0.974176, green: 0.53678, blue: 0.048392 },
    { position: 0.745098, red: 0.975677, green: 0.543798, blue: 0.043618 },
    { position: 0.74902, red: 0.977092, green: 0.55085, blue: 0.03905 },
    { position: 0.752941, red: 0.978422, green: 0.557937, blue: 0.034931 },
    { position: 0.756863, red: 0.979666, green: 0.565057, blue: 0.031409 },
    { position: 0.760784, red: 0.980824, green: 0.572209, blue: 0.028508 },
    { position: 0.764706, red: 0.981895, green: 0.579392, blue: 0.02625 },
    { position: 0.768627, red: 0.982881, green: 0.586606, blue: 0.024661 },
    { position: 0.772549, red: 0.983779, green: 0.593849, blue: 0.02377 },
    { position: 0.776471, red: 0.984591, green: 0.601122, blue: 0.023606 },
    { position: 0.780392, red: 0.985315, green: 0.608422, blue: 0.024202 },
    { position: 0.784314, red: 0.985952, green: 0.61575, blue: 0.025592 },
    { position: 0.788235, red: 0.986502, green: 0.623105, blue: 0.027814 },
    { position: 0.792157, red: 0.986964, green: 0.630485, blue: 0.030908 },
    { position: 0.796078, red: 0.987337, green: 0.63789, blue: 0.034916 },
    { position: 0.8, red: 0.987622, green: 0.64532, blue: 0.039886 },
    { position: 0.803922, red: 0.987819, green: 0.652773, blue: 0.045581 },
    { position: 0.807843, red: 0.987926, green: 0.66025, blue: 0.05175 },
    { position: 0.811765, red: 0.987945, green: 0.667748, blue: 0.058329 },
    { position: 0.815686, red: 0.987874, green: 0.675267, blue: 0.065257 },
    { position: 0.819608, red: 0.987714, green: 0.682807, blue: 0.072489 },
    { position: 0.823529, red: 0.987464, green: 0.690366, blue: 0.07999 },
    { position: 0.827451, red: 0.987124, green: 0.697944, blue: 0.087731 },
    { position: 0.831373, red: 0.986694, green: 0.70554, blue: 0.095694 },
    { position: 0.835294, red: 0.986175, green: 0.713153, blue: 0.103863 },
    { position: 0.839216, red: 0.985566, green: 0.720782, blue: 0.112229 },
    { position: 0.843137, red: 0.984865, green: 0.728427, blue: 0.120785 },
    { position: 0.847059, red: 0.984075, green: 0.736087, blue: 0.129527 },
    { position: 0.85098, red: 0.983196, green: 0.743758, blue: 0.138453 },
    { position: 0.854902, red: 0.982228, green: 0.751442, blue: 0.147565 },
    { position: 0.858824, red: 0.981173, green: 0.759135, blue: 0.156863 },
    { position: 0.862745, red: 0.980032, green: 0.766837, blue: 0.166353 },
    { position: 0.866667, red: 0.978806, green: 0.774545, blue: 0.176037 },
    { position: 0.870588, red: 0.977497, green: 0.782258, blue: 0.185923 },
    { position: 0.87451, red: 0.976108, green: 0.789974, blue: 0.196018 },
    { position: 0.878431, red: 0.974638, green: 0.797692, blue: 0.206332 },
    { position: 0.882353, red: 0.973088, green: 0.805409, blue: 0.216877 },
    { position: 0.886275, red: 0.971468, green: 0.813122, blue: 0.227658 },
    { position: 0.890196, red: 0.969783, green: 0.820825, blue: 0.238686 },
    { position: 0.894118, red: 0.968041, green: 0.828515, blue: 0.249972 },
    { position: 0.898039, red: 0.966243, green: 0.836191, blue: 0.261534 },
    { position: 0.901961, red: 0.964394, green: 0.843848, blue: 0.273391 },
    { position: 0.905882, red: 0.962517, green: 0.851476, blue: 0.285546 },
    { position: 0.909804, red: 0.960626, green: 0.859069, blue: 0.29801 },
    { position: 0.913725, red: 0.95872, green: 0.866624, blue: 0.31082 },
    { position: 0.917647, red: 0.956834, green: 0.874129, blue: 0.323974 },
    { position: 0.921569, red: 0.954997, green: 0.881569, blue: 0.337475 },
    { position: 0.92549, red: 0.953215, green: 0.888942, blue: 0.351369 },
    { position: 0.929412, red: 0.951546, green: 0.896226, blue: 0.365627 },
    { position: 0.933333, red: 0.950018, green: 0.903409, blue: 0.380271 },
    { position: 0.937255, red: 0.948683, green: 0.910473, blue: 0.395289 },
    { position: 0.941176, red: 0.947594, green: 0.917399, blue: 0.410665 },
    { position: 0.945098, red: 0.946809, green: 0.924168, blue: 0.426373 },
    { position: 0.94902, red: 0.946392, green: 0.930761, blue: 0.442367 },
    { position: 0.952941, red: 0.946403, green: 0.937159, blue: 0.458592 },
    { position: 0.956863, red: 0.946903, green: 0.943348, blue: 0.47497 },
    { position: 0.960784, red: 0.947937, green: 0.949318, blue: 0.491426 },
    { position: 0.964706, red: 0.949545, green: 0.955063, blue: 0.50786 },
    { position: 0.968627, red: 0.95174, green: 0.960587, blue: 0.524203 },
    { position: 0.972549, red: 0.954529, green: 0.965896, blue: 0.540361 },
    { position: 0.976471, red: 0.957896, green: 0.971003, blue: 0.556275 },
    { position: 0.980392, red: 0.961812, green: 0.975924, blue: 0.571925 },
    { position: 0.984314, red: 0.966249, green: 0.980678, blue: 0.587206 },
    { position: 0.988235, red: 0.971162, green: 0.985282, blue: 0.602154 },
    { position: 0.992157, red: 0.976511, green: 0.989753, blue: 0.61676 },
    { position: 0.996078, red: 0.982257, green: 0.994109, blue: 0.631017 },
    { position: 1.0, red: 0.988362, green: 0.998364, blue: 0.644924 }
];

const INFERNO_DEF: ColormapDefinition = {
    name: 'Inferno',
    paraviewPreset: 'Inferno',
    colorSpace: 'Lab',
    nanColor: [0, 1, 0] as const,
    stops: INFERNO_STOPS
};

const JET_STOPS: readonly ColormapStop[] = [
    { position: -1, red: 0, green: 0, blue: 0.5625 },
    { position: -0.777778, red: 0, green: 0, blue: 1 },
    { position: -0.269841, red: 0, green: 1, blue: 1 },
    { position: -0.015873, red: 0.5, green: 1, blue: 0.5 },
    { position: 0.238095, red: 1, green: 1, blue: 0 },
    { position: 0.746032, red: 1, green: 0, blue: 0 },
    { position: 1, red: 0.5, green: 0, blue: 0 }
];

const JET_DEF: ColormapDefinition = {
    name: 'Jet',
    paraviewPreset: 'Jet',
    colorSpace: 'RGB',
    nanColor: null,
    stops: JET_STOPS
};

const HOT_STOPS: readonly ColormapStop[] = [
    { position: -1, red: 0.0416667, green: 0, blue: 0 },
    { position: -0.873016, red: 0.208333, green: 0, blue: 0 },
    { position: -0.746032, red: 0.375, green: 0, blue: 0 },
    { position: -0.619048, red: 0.541667, green: 0, blue: 0 },
    { position: -0.492063, red: 0.708333, green: 0, blue: 0 },
    { position: -0.365079, red: 0.854137, green: 0, blue: 0 },
    { position: -0.238095, red: 0.937488, green: 0.039062, blue: 0 },
    { position: -0.111111, red: 1, green: 0.208333, blue: 0 },
    { position: 0.015873, red: 1, green: 0.375, blue: 0 },
    { position: 0.142857, red: 1, green: 0.541667, blue: 0 },
    { position: 0.269841, red: 1, green: 0.708333, blue: 0 },
    { position: 0.396825, red: 1, green: 0.858805, blue: 0.03125 },
    { position: 0.52381, red: 1, green: 0.947392, blue: 0.15625 },
    { position: 0.650794, red: 1, green: 1, blue: 0.3125 },
    { position: 0.777778, red: 1, green: 1, blue: 0.5625 },
    { position: 0.904762, red: 1, green: 1, blue: 0.8125 },
    { position: 1, red: 1, green: 1, blue: 1 }
];

const HOT_DEF: ColormapDefinition = {
    name: 'Hot',
    paraviewPreset: '2hot',
    colorSpace: 'Lab',
    nanColor: null,
    stops: HOT_STOPS
};

const COOL_STOPS: readonly ColormapStop[] = [
    { position: 0.0, red: 0.4588235294117647, green: 0.6941176470588235, blue: 0.00392156862745098 },
    { position: 0.16666666666666666, red: 0.3450980392156863, green: 0.5019607843137255, blue: 0.1607843137254902 },
    { position: 0.3333333333333333, red: 0.3137254901960784, green: 0.8431372549019608, blue: 0.7490196078431373 },
    { position: 0.5, red: 0.1098039215686274, green: 0.5843137254901961, blue: 0.803921568627451 },
    { position: 0.6666666666666666, red: 0.2313725490196079, green: 0.407843137254902, blue: 0.6705882352941176 },
    { position: 0.8333333333333334, red: 0.6039215686274509, green: 0.407843137254902, blue: 1 },
    { position: 1.0, red: 0.3725490196078431, green: 0.2, blue: 0.5019607843137255 }
];

const COOL_DEF: ColormapDefinition = {
    name: 'Cool',
    paraviewPreset: 'Cool',
    colorSpace: 'Indexed',
    nanColor: [0.3725490196078431, 0.2, 0.5019607843137255] as const,
    stops: COOL_STOPS
};

/** Short-list LUT pack keyed by toolbar colormap name. */
export const SHORT_COLORMAPS: Record<ShortColormapName, ColormapDefinition> = {
    Plasma: PLASMA_DEF,
    Viridis: VIRIDIS_DEF,
    Inferno: INFERNO_DEF,
    Jet: JET_DEF,
    Hot: HOT_DEF,
    Cool: COOL_DEF
};
