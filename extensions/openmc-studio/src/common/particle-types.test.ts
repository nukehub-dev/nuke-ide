import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENMC_COMPAT } from './openmc-studio-protocol';
import {
    coerceParticleType,
    isBaseParticle,
    isParticleSupported,
    legacyParticleBin,
    legacyParticleBins,
    NEUTRON_PARTICLE,
    normalizeParticleType,
    OPENMC_PARTICLE_PRESETS,
    particleFromLegacyBin,
    particleTypeName,
    particleTypeTooltip,
    PHOTON_PARTICLE,
    resolveParticleType,
    sanitizeSourceParticle,
    sanitizeWeightWindowParticle
} from './particle-types';

describe('OpenMC particle presets', () => {
    it('uses the canonical names OpenMC serializes for the common presets', () => {
        const byLabel = Object.fromEntries(OPENMC_PARTICLE_PRESETS.map((preset) => [preset.label, preset]));
        expect(byLabel['Neutron']).toMatchObject({ name: 'neutron', pdg: 2112 });
        expect(byLabel['Photon']).toMatchObject({ name: 'photon', pdg: 22 });
        expect(byLabel['Electron']).toMatchObject({ name: 'electron', pdg: 11 });
        expect(byLabel['Positron']).toMatchObject({ name: 'positron', pdg: -11 });
        expect(byLabel['Proton (H1)']).toMatchObject({ name: 'H1', pdg: 2212 });
        expect(byLabel['Deuteron (H2)']).toMatchObject({ name: 'H2', pdg: 1000010020 });
        expect(byLabel['Triton (H3)']).toMatchObject({ name: 'H3', pdg: 1000010030 });
        expect(byLabel['Alpha (He4)']).toMatchObject({ name: 'He4', pdg: 1000020040 });
        expect(byLabel['Helium-3 (He3)']).toMatchObject({ name: 'He3', pdg: 1000020030 });
    });
});

describe('resolveParticleType', () => {
    it('resolves OpenMC aliases and canonical names', () => {
        expect(resolveParticleType('alpha').particle).toEqual({ name: 'He4', pdg: 1000020040 });
        expect(resolveParticleType('He4').particle).toEqual({ name: 'He4', pdg: 1000020040 });
        expect(resolveParticleType('proton').particle).toEqual({ name: 'H1', pdg: 2212 });
        expect(resolveParticleType('He3').particle).toEqual({ name: 'He3', pdg: 1000020030 });
        expect(resolveParticleType('U235').particle).toEqual({ name: 'U235', pdg: 1000922350 });
        expect(resolveParticleType('U235_m1').particle).toEqual({ name: 'U235_m1', pdg: 1000922351 });
    });

    it('resolves PDG numbers and pdg-prefixed strings', () => {
        expect(resolveParticleType(2112).particle).toEqual(NEUTRON_PARTICLE);
        expect(resolveParticleType(22).particle).toEqual(PHOTON_PARTICLE);
        expect(resolveParticleType('pdg:2212').particle).toEqual({ name: 'H1', pdg: 2212 });
        expect(resolveParticleType(1000020040).particle).toEqual({ name: 'He4', pdg: 1000020040 });
        expect(resolveParticleType(12345).particle).toEqual({ name: 'pdg:12345', pdg: 12345 });
    });

    it('rejects unknown names and malformed PDG codes with an actionable message', () => {
        const unknown = resolveParticleType('muon');
        expect(unknown.ok).toBe(false);
        expect(unknown.error).toContain('not a recognized OpenMC particle');
        expect(resolveParticleType('').ok).toBe(false);
        expect(resolveParticleType(1000000001).ok).toBe(false);
        expect(resolveParticleType(1.5).ok).toBe(false);
        expect(resolveParticleType('pdg:not-a-number').ok).toBe(false);
        expect(resolveParticleType({ name: 'photon', pdg: 2112 }).ok).toBe(false);
    });

    it('normalizes legacy values without dropping unknown names', () => {
        expect(normalizeParticleType('neutron')).toEqual(NEUTRON_PARTICLE);
        expect(normalizeParticleType('photon')).toEqual(PHOTON_PARTICLE);
        expect(normalizeParticleType('custom-particle')).toEqual({ name: 'custom-particle' });
        expect(normalizeParticleType(undefined)).toBeUndefined();
    });
});

describe('particle support', () => {
    it('treats neutron/photon/electron/positron as the base 0.15.3 surface', () => {
        expect(isBaseParticle(NEUTRON_PARTICLE)).toBe(true);
        expect(isBaseParticle(PHOTON_PARTICLE)).toBe(true);
        expect(isBaseParticle({ name: 'electron', pdg: 11 })).toBe(true);
        expect(isBaseParticle({ name: 'positron', pdg: -11 })).toBe(true);
        expect(isBaseParticle({ name: 'He4', pdg: 1000020040 })).toBe(false);
    });

    it('gates generalized particles on the probed capability while allowing unknown probe state', () => {
        const he4 = { name: 'He4', pdg: 1000020040 };
        expect(isParticleSupported(he4, 'source', undefined)).toBe(true);
        expect(isParticleSupported(he4, 'source', { ...DEFAULT_OPENMC_COMPAT, generalizedParticles: true })).toBe(true);
        expect(isParticleSupported(he4, 'source', { ...DEFAULT_OPENMC_COMPAT })).toBe(false);
        expect(isParticleSupported({ name: 'electron', pdg: 11 }, 'source', { ...DEFAULT_OPENMC_COMPAT })).toBe(true);
    });

    it('restricts weight windows to neutron and photon regardless of the PDG probe', () => {
        const compat = { ...DEFAULT_OPENMC_COMPAT, generalizedParticles: true };
        expect(isParticleSupported(NEUTRON_PARTICLE, 'weight-window', compat)).toBe(true);
        expect(isParticleSupported(PHOTON_PARTICLE, 'weight-window', compat)).toBe(true);
        expect(isParticleSupported({ name: 'electron', pdg: 11 }, 'weight-window', compat)).toBe(false);
        expect(isParticleSupported({ name: 'He4', pdg: 1000020040 }, 'weight-window', compat)).toBe(false);
    });

    it('falls back to neutron with a warning when generation cannot represent a particle', () => {
        const source = sanitizeSourceParticle({ name: 'He4', pdg: 1000020040 }, { ...DEFAULT_OPENMC_COMPAT, generalizedParticles: false });
        expect(source.particle).toEqual(NEUTRON_PARTICLE);
        expect(source.warning).toContain('requires OpenMC 0.16');

        const weightWindow = sanitizeWeightWindowParticle({ name: 'electron', pdg: 11 }, 'Weight-window set 1');
        expect(weightWindow.particle).toEqual(NEUTRON_PARTICLE);
        expect(weightWindow.warning).toContain('not supported by OpenMC weight windows');
    });
});

describe('legacy particle bins and descriptions', () => {
    it('maps the internal legacy numeric bins both ways', () => {
        expect(particleFromLegacyBin(1)).toEqual(NEUTRON_PARTICLE);
        expect(particleFromLegacyBin(2)).toEqual(PHOTON_PARTICLE);
        expect(particleFromLegacyBin(3)).toEqual({ name: 'electron', pdg: 11 });
        expect(particleFromLegacyBin(4)).toEqual({ name: 'positron', pdg: -11 });
        expect(particleFromLegacyBin(9)).toBeUndefined();
        expect(legacyParticleBin(NEUTRON_PARTICLE)).toBe(1);
        expect(legacyParticleBins([NEUTRON_PARTICLE, PHOTON_PARTICLE])).toEqual([1, 2]);
        expect(legacyParticleBins([PHOTON_PARTICLE, { name: 'He4', pdg: 1000020040 }])).toEqual([]);
    });

    it('keeps the canonical name and PDG in the tooltip', () => {
        const tooltip = particleTypeTooltip({ name: 'H1', pdg: 2212 });
        expect(tooltip).toContain('OpenMC name: H1');
        expect(tooltip).toContain('PDG 2212');
        expect(particleTypeName({ name: 'He4', pdg: 1000020040 })).toBe('He4');
        expect(coerceParticleType('photon')).toEqual(PHOTON_PARTICLE);
    });
});
