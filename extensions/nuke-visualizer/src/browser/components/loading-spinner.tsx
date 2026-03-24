// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as React from 'react';
import { codicon } from '@theia/core/lib/browser/widgets/widget';

/**
 * Global animation styles for loading components.
 * Include this once in your component's render method.
 */
export const LoadingAnimations = (): React.ReactElement => (
    <style>{`
        @keyframes nuke-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        @keyframes nuke-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        @keyframes nuke-fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
    `}</style>
);

interface FancyLoadingSpinnerProps {
    /** Main message to display */
    message: string;
    /** Optional sub-message */
    subMessage?: string;
    /** Container style overrides */
    style?: React.CSSProperties;
}

/**
 * Fancy loading spinner with dual-ring animation.
 * Used for visualization loading states.
 */
export const FancyLoadingSpinner = ({ message, subMessage, style }: FancyLoadingSpinnerProps): React.ReactElement => (
    <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        animation: 'nuke-fadeIn 0.3s ease-out',
        ...style
    }}>
        <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center',
            padding: '32px',
            background: 'var(--theia-editorWidget-background, rgba(100,100,100,0.1))',
            borderRadius: '12px',
            border: '1px solid var(--theia-panel-border)'
        }}>
            {/* Animated dual-ring spinner */}
            <div style={{ 
                width: '56px', 
                height: '56px', 
                position: 'relative',
                marginBottom: '20px'
            }}>
                <div style={{
                    position: 'absolute',
                    inset: '0',
                    borderRadius: '50%',
                    border: '3px solid transparent',
                    borderTopColor: 'var(--theia-focusBorder, #007fd4)',
                    borderRightColor: 'var(--theia-focusBorder, #007fd4)',
                    animation: 'nuke-spin 1s linear infinite'
                }}></div>
                <div style={{
                    position: 'absolute',
                    inset: '6px',
                    borderRadius: '50%',
                    border: '3px solid transparent',
                    borderBottomColor: 'var(--theia-charts-blue, #3794ff)',
                    borderLeftColor: 'var(--theia-charts-blue, #3794ff)',
                    animation: 'nuke-spin 1.5s linear infinite reverse'
                }}></div>
            </div>
            <div style={{ 
                fontSize: '15px', 
                fontWeight: 500,
                color: 'var(--theia-foreground)',
                marginBottom: '8px'
            }}>
                {message}
            </div>
            {subMessage && (
                <div style={{
                    fontSize: '12px',
                    color: 'var(--theia-descriptionForeground)',
                    animation: 'nuke-pulse 2s ease-in-out infinite'
                }}>
                    {subMessage}
                </div>
            )}
        </div>
    </div>
);

interface SimpleLoadingSpinnerProps {
    /** Message to display */
    message: string;
}

/**
 * Simple loading spinner with rotating icon.
 * Used for tree widgets and sidebar loading states.
 */
export const SimpleLoadingSpinner = ({ message }: SimpleLoadingSpinnerProps): React.ReactElement => (
    <div style={{ 
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        textAlign: 'center',
        padding: '40px 20px'
    }}>
        <i className={codicon('loading')} style={{ 
            animation: 'nuke-spin 1s linear infinite',
            fontSize: '48px',
            marginBottom: '16px',
            color: 'var(--theia-textLink-foreground)'
        }}></i>
        <div style={{ 
            fontSize: '14px',
            color: 'var(--theia-descriptionForeground)',
            fontWeight: 500
        }}>{message}</div>
    </div>
);

interface ErrorDisplayProps {
    /** Error message to display */
    message: string;
    /** Optional retry action */
    onRetry?: () => void;
    /** Retry button label */
    retryLabel?: string;
}

/**
 * Error display component with consistent styling.
 */
export const ErrorDisplay = ({ message, onRetry, retryLabel = 'Retry' }: ErrorDisplayProps): React.ReactElement => (
    <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '24px'
    }}>
        <div style={{ 
            color: 'var(--theia-errorForeground)',
            backgroundColor: 'var(--theia-inputValidation-errorBackground, rgba(244, 67, 54, 0.1))',
            border: '1px solid var(--theia-inputValidation-errorBorder, #f44336)',
            padding: '16px 20px',
            borderRadius: '8px',
            maxWidth: '480px',
            textAlign: 'left'
        }}>
            <div style={{ 
                fontWeight: 600, 
                marginBottom: '10px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
            }}>
                <i className={codicon('error')} style={{ fontSize: '16px' }} />
                Error
            </div>
            <div style={{ fontSize: '13px', lineHeight: '1.5' }}>{message}</div>
        </div>
        {onRetry && (
            <button 
                onClick={onRetry}
                style={{
                    marginTop: '16px',
                    padding: '6px 14px',
                    background: 'var(--theia-button-background)',
                    color: 'var(--theia-button-foreground)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 500
                }}
            >
                <i className={codicon('refresh')} style={{ marginRight: '6px' }}></i>
                {retryLabel}
            </button>
        )}
    </div>
);

interface EmptyStateProps {
    /** Icon class name */
    icon: string;
    /** Message to display */
    message: string;
    /** Optional action button */
    actionLabel?: string;
    /** Action button handler */
    onAction?: () => void;
}

/**
 * Empty state display component.
 */
export const EmptyState = ({ icon, message, actionLabel, onAction }: EmptyStateProps): React.ReactElement => (
    <div style={{ 
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        textAlign: 'center',
        padding: '40px 20px'
    }}>
        <i className={codicon(icon)} style={{
            fontSize: '48px',
            marginBottom: '16px',
            opacity: 0.5
        }}></i>
        <div style={{ 
            fontSize: '14px',
            color: 'var(--theia-descriptionForeground)',
            marginBottom: actionLabel ? '16px' : '0'
        }}>{message}</div>
        {actionLabel && onAction && (
            <button 
                onClick={onAction}
                style={{
                    padding: '6px 14px',
                    background: 'var(--theia-button-background)',
                    color: 'var(--theia-button-foreground)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px'
                }}
            >
                <i className='fa fa-folder'></i>
                {actionLabel}
            </button>
        )}
    </div>
);
