// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

export interface ThemeColors {
    accent: string;
    accentLight: string;
    accentDark: string;
    background: string;
    backgroundRgb: string;
    foreground: string;
    foregroundInverse: string;
}

export interface ThemeConfig {
    id: string;
    label: string;
    type: 'dark' | 'light';
    colors: ThemeColors;
}

export const THEME_CONFIGS: ThemeConfig[] = [
    {
        id: 'nukeide-dark',
        label: 'Dark',
        type: 'dark',
        colors: {
            accent: '#f37524',
            accentLight: '#ff9500',
            accentDark: '#f5a623',
            background: '#1e1e1e',
            backgroundRgb: '30, 30, 30',
            foreground: '#d4d4d4',
            foregroundInverse: '#ffffff'
        }
    },
    {
        id: 'nukeide-light',
        label: 'Light',
        type: 'light',
        colors: {
            accent: '#e06010',
            accentLight: '#ff9500',
            accentDark: '#f5a623',
            background: '#ffffff',
            backgroundRgb: '255, 255, 255',
            foreground: '#2c3e50',
            foregroundInverse: '#ffffff'
        }
    },
    {
        id: 'nukeide-blue-dark',
        label: 'Blue Dark',
        type: 'dark',
        colors: {
            accent: '#4fc3f7',
            accentLight: '#81d4fa',
            accentDark: '#29b6f6',
            background: '#1a1a2e',
            backgroundRgb: '26, 26, 46',
            foreground: '#e0e0e0',
            foregroundInverse: '#ffffff'
        }
    },
    {
        id: 'nukeide-blue-light',
        label: 'Blue Light',
        type: 'light',
        colors: {
            accent: '#0288d1',
            accentLight: '#039be5',
            accentDark: '#0277bd',
            background: '#e3f2fd',
            backgroundRgb: '227, 242, 253',
            foreground: '#2c3e50',
            foregroundInverse: '#ffffff'
        }
    },
    {
        id: 'nukeide-red-dark',
        label: 'Red Dark',
        type: 'dark',
        colors: {
            accent: '#e53935',
            accentLight: '#ef5350',
            accentDark: '#c62828',
            background: '#1a1010',
            backgroundRgb: '26, 16, 16',
            foreground: '#e0e0e0',
            foregroundInverse: '#ffffff'
        }
    },
    {
        id: 'nukeide-red-light',
        label: 'Red Light',
        type: 'light',
        colors: {
            accent: '#d32f2f',
            accentLight: '#f44336',
            accentDark: '#b71c1c',
            background: '#fff5f5',
            backgroundRgb: '255, 245, 245',
            foreground: '#2c3e50',
            foregroundInverse: '#ffffff'
        }
    }
];

export function getThemeConfig(themeId: string): ThemeConfig | undefined {
    return THEME_CONFIGS.find(t => t.id === themeId);
}

export function getThemeForType(type: 'dark' | 'light'): ThemeConfig | undefined {
    return THEME_CONFIGS.find(t => t.type === type);
}
