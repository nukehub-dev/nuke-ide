import { describe, expect, it } from 'vitest';
import {
    buildContactDoseChart,
    buildDecaySpectrumChart,
    contactDoseHasSignal,
    contactDoseNuclideRows,
    contactDoseToCsv,
    decaySpectrumToCsv,
    defaultScaleForPlot,
    doseQuantityForPlot,
    formatActivityBq,
    formatDoseRate,
    isContactDosePlot,
    isSpectrumPlot,
    stepLabel
} from './depletion-analysis';
import {
    OpenMCDepletionContactDoseResult,
    OpenMCDepletionDecaySpectrumResult,
    OpenMCDepletionSummary
} from '../../../../../common/openmc-protocol';

const summary: OpenMCDepletionSummary = {
    nMaterials: 1,
    nSteps: 2,
    nNuclides: 3,
    timePoints: [0, 86400],
    timeDays: [0, 1],
    burnup: [0, 1.5]
};

const dose: OpenMCDepletionContactDoseResult = {
    success: true,
    materialIndex: 4,
    materialName: 'Cell 1',
    doseQuantity: 'absorbed-air',
    unit: 'Gy/h',
    buildUp: 2,
    timeSeconds: [0, 86400],
    timeDays: [0, 1],
    total: [1e-6, 2.6e4],
    contributingNuclides: 2,
    byNuclide: [
        { nuclide: 'I135', values: [1e-6, 1.7e4] },
        { nuclide: 'Ru105', values: [0, 2.6e3] },
        { nuclide: 'O16', values: [0, 0] }
    ]
};

const spectrum: OpenMCDepletionDecaySpectrumResult = {
    success: true,
    materialIndex: 4,
    materialName: 'Cell 1',
    timeIndex: 1,
    timeSeconds: 86400,
    timeDays: 1,
    totalActivityBq: 2.372e12,
    totalPhotonIntensityBq: 2.351e12,
    kind: 'discrete',
    lines: [
        { energyEv: 1.29e5, intensity: 100 },
        { energyEv: 2.16e5, intensity: 50 }
    ],
    curves: []
};

describe('depletion analysis helpers', () => {
    it('maps plot types to quantities and default scales', () => {
        expect(doseQuantityForPlot('contact_dose_air')).toBe('absorbed-air');
        expect(doseQuantityForPlot('contact_dose_effective')).toBe('effective');
        expect(isContactDosePlot('contact_dose_air')).toBe(true);
        expect(isSpectrumPlot('decay_spectrum')).toBe(true);
        expect(defaultScaleForPlot('concentration')).toBe('linear');
        expect(defaultScaleForPlot('decay_spectrum')).toBe('log');
    });

    it('formats step labels and units', () => {
        expect(stepLabel(1, 1)).toBe('Step 1 · 1 d');
        expect(stepLabel(undefined, 2)).toBe('Step 2');
        expect(formatDoseRate(2.5e4, 'Gy/h')).toBe('25,000 Gy/h');
        expect(formatActivityBq(2.372e12)).toBe('2.372 TBq');
        expect(formatActivityBq(8468)).toBe('8.468 kBq');
    });

    it('builds contact-dose traces on the selected x-axis', () => {
        const chart = buildContactDoseChart(dose, summary, 'time');
        expect(chart.xLabel).toBe('Time (days)');
        expect(chart.yLabel).toBe('Contact dose rate (Gy/h)');
        expect(chart.traces[0].x).toEqual([0, 1]);
        const burnupChart = buildContactDoseChart(dose, summary, 'burnup');
        expect(burnupChart.traces[0].x).toEqual([0, 1.5]);
    });

    it('sorts by-nuclide rows and drops zero-only contributors', () => {
        expect(contactDoseHasSignal(dose)).toBe(true);
        expect(contactDoseNuclideRows(dose).map((row) => row.nuclide)).toEqual(['I135', 'Ru105']);
        expect(contactDoseHasSignal({ ...dose, total: [0, 0] })).toBe(false);
    });

    it('shapes the decay spectrum with energy in MeV and total activity in the legend', () => {
        const chart = buildDecaySpectrumChart(spectrum);
        expect(chart.traces).toHaveLength(1);
        expect(chart.traces[0].x).toEqual([0.129, 0.216]);
        expect(String(chart.traces[0].name)).toContain('Total activity 2.372 TBq');
        expect(chart.yLabel).toContain('photons s⁻¹');
    });

    it('exports spectrum and contact-dose CSV with units', () => {
        const csv = decaySpectrumToCsv(spectrum);
        expect(csv.split('\n')[0]).toBe('material,time_index,time_days,energy_MeV,value,unit,component');
        expect(csv).toContain('Cell 1,1,1');
        expect(csv).toContain('photons/s');
        const doseCsv = contactDoseToCsv(dose);
        expect(doseCsv.split('\n')[0]).toBe('nuclide,t=0 d,t=1 d');
        expect(doseCsv).toContain('I135');
    });
});
