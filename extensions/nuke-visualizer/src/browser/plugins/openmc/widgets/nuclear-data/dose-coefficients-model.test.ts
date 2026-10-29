import { describe, expect, it } from 'vitest';
import {
    buildDoseCoefficientTrace,
    doseCoefficientAxisLabel,
    doseCoefficientRows,
    doseParticleLabel,
    doseQuantityLabel,
    geometryOptions,
    resolveGeometry
} from './dose-coefficients-model';
import { DoseCoefficientsResult } from '../../../../../common/openmc-protocol';

const result: DoseCoefficientsResult = {
    success: true,
    particle: 'photon',
    dataSource: 'icrp116',
    doseQuantity: 'effective',
    geometry: 'AP',
    energyEv: [1e4, 1e5, 1e6],
    response: [0.1, 0.2, 0.5],
    units: 'pSv cm^2',
    availableParticles: ['photon', 'neutron'],
    availableGeometries: ['AP', 'PA', 'LLAT', 'RLAT', 'ROT', 'ISO']
};

describe('dose coefficient reference model', () => {
    it('labels particles and quantities', () => {
        expect(doseParticleLabel('photon kerma')).toBe('Photon kerma');
        expect(doseParticleLabel('helium')).toBe('Helium ion');
        expect(doseQuantityLabel('ambient')).toBe('Ambient dose equivalent H*(10)');
        expect(doseQuantityLabel('effective')).toBe('Effective dose');
    });

    it('puts the coefficient unit in the axis label', () => {
        expect(doseCoefficientAxisLabel('pSv cm^2')).toBe('Dose coefficient (pSv cm^2)');
        expect(doseCoefficientAxisLabel(undefined)).toBe('Dose coefficient (pSv cm²)');
    });

    it('shapes the chart with energy in MeV and table rows in grid order', () => {
        const trace = buildDoseCoefficientTrace(result)[0];
        expect(trace.x).toEqual([0.01, 0.1, 1]);
        expect(trace.y).toEqual([0.1, 0.2, 0.5]);
        expect(doseCoefficientRows(result)).toEqual([
            { energyMeV: 0.01, coefficient: 0.1 },
            { energyMeV: 0.1, coefficient: 0.2 },
            { energyMeV: 1, coefficient: 0.5 }
        ]);
    });

    it('limits ambient dose to the AP geometry and falls back when a geometry is unavailable', () => {
        expect(geometryOptions('ambient', result.availableGeometries)).toEqual(['AP']);
        expect(resolveGeometry(['AP', 'PA', 'ISO'], 'RLAT')).toBe('AP');
        expect(resolveGeometry(undefined, 'ROT')).toBe('ROT');
    });
});
