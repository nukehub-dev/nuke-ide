// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { PreferenceChangeEvent } from '@theia/core/lib/common/preferences';
import { SysmonFrontendService } from './sysmon-service';
import { HistoricalData, SystemMetrics, DiskInfo } from '../common/sysmon-protocol';
import { SysmonPreferences, SysmonConfiguration } from './sysmon-preferences';

// Import CSS
import './sysmon-widget.css';

@injectable()
export class SysmonWidget extends ReactWidget {
    static readonly ID = 'sysmon-dashboard';
    static readonly LABEL = 'System Monitor';

    @inject(SysmonFrontendService)
    protected readonly sysmonService: SysmonFrontendService;

    @inject(SysmonPreferences)
    protected readonly preferences: SysmonPreferences;

    private historicalData: HistoricalData | null = null;
    private currentMetrics: SystemMetrics | null = null;
    private disks: DiskInfo[] = [];
    private selectedDiskIndex = 0;
    private updateInterval: NodeJS.Timeout | null = null;
    private showDiskDropdown = false;
    private loading = true;
    private currentIntervalMs: number = 2000;

    @postConstruct()
    protected init(): void {
        this.id = SysmonWidget.ID;
        this.title.label = SysmonWidget.LABEL;
        this.title.caption = SysmonWidget.LABEL;
        this.title.closable = true;
        this.node.classList.add('sysmon-widget');

        // Watch for preference changes
        this.preferences.onPreferenceChanged((event: PreferenceChangeEvent<SysmonConfiguration>) => {
            if (event.preferenceName === 'sysmon.updateInterval') {
                this.currentIntervalMs = this.preferences['sysmon.updateInterval'];
                this.restartUpdating();
            }
        });
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.disablePerfectScrollbar();
        this.loadDisks();
        this.startUpdating();
    }

    private disablePerfectScrollbar(): void {
        // Remove the .ps class to prevent perfect-scrollbar from activating
        this.node.classList.remove('ps');
        
        // Remove any existing rails
        const rails = this.node.querySelectorAll('.ps__rail-x, .ps__rail-y');
        rails.forEach(rail => rail.remove());
        
        // Watch for perfect-scrollbar adding elements and remove them immediately
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLElement) {
                        if (node.classList.contains('ps__rail-x') || 
                            node.classList.contains('ps__rail-y')) {
                            node.remove();
                        }
                    }
                });
            });
            // Also ensure .ps class is never added
            if (this.node.classList.contains('ps')) {
                this.node.classList.remove('ps');
            }
        });
        
        observer.observe(this.node, {
            childList: true,
            subtree: false,
            attributes: true,
            attributeFilter: ['class']
        });
        
        // Store observer for cleanup
        (this as any)._psObserver = observer;
    }

    protected onBeforeDetach(msg: Message): void {
        super.onBeforeDetach(msg);
        this.stopUpdating();
        // Clean up the observer
        const observer = (this as any)._psObserver;
        if (observer) {
            observer.disconnect();
        }
    }

    private get Plotly(): any {
        return (window as any).Plotly;
    }

    private async loadDisks(): Promise<void> {
        try {
            this.disks = await this.sysmonService.getAllDisks();
            this.update();
        } catch (error) {
            console.error('Failed to load disks:', error);
        }
    }

    private async selectDisk(index: number): Promise<void> {
        if (index === this.selectedDiskIndex) {
            this.showDiskDropdown = false;
            this.update();
            return;
        }
        
        try {
            await this.sysmonService.setSelectedDisk(index);
            this.selectedDiskIndex = index;
            this.showDiskDropdown = false;
            this.currentMetrics = await this.sysmonService.getCurrentMetrics();
            this.update();
        } catch (error) {
            console.error('Failed to select disk:', error);
        }
    }

    private startUpdating(): void {
        // Get interval from preferences
        this.currentIntervalMs = this.preferences['sysmon.updateInterval'];
        this.updateData();
        this.updateInterval = setInterval(() => {
            this.updateData();
        }, this.currentIntervalMs);
    }

    private restartUpdating(): void {
        this.stopUpdating();
        this.startUpdating();
    }

    private stopUpdating(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    private async updateData(): Promise<void> {
        try {
            const [history, current] = await Promise.all([
                this.sysmonService.getHistoricalData(60),
                this.sysmonService.getCurrentMetrics()
            ]);
            this.historicalData = history;
            this.currentMetrics = current;
            this.loading = false;
            this.update();
        } catch (error) {
            console.error('Failed to fetch system data:', error);
        }
    }

    protected render(): React.ReactNode {
        if (this.loading) {
            return (
                <div className="sysmon-loading">
                    <div className="sysmon-loading-spinner" />
                    <span>Loading system metrics...</span>
                </div>
            );
        }

        return (
            <div className="sysmon-container">
                {this.renderHeader()}
                <div className="sysmon-dashboard">
                    {this.renderCpuCard()}
                    {this.renderMemoryCard()}
                    {this.renderDiskCard()}
                    {this.renderNetworkCard()}
                </div>
                {this.Plotly && this.historicalData && this.renderGraphsSection()}
                {this.renderSystemInfo()}
            </div>
        );
    }

    private renderHeader(): React.ReactNode {
        const uptime = this.historicalData && this.historicalData.timestamps.length > 0 
            ? this.formatUptime(Date.now() - this.historicalData.timestamps[0]) 
            : '--';
        
        return (
            <div className="sysmon-header">
                <div className="sysmon-header-left">
                    <h1 className="sysmon-title">System Monitor</h1>
                    <span className="sysmon-subtitle">Real-time system performance metrics • Uptime: {uptime}</span>
                </div>
                <div className="sysmon-header-right">
                    <div className="sysmon-status-badge">
                        <span className="sysmon-status-dot" />
                        <span>Live Monitoring</span>
                    </div>
                </div>
            </div>
        );
    }

    private renderCpuCard(): React.ReactNode {
        if (!this.currentMetrics || !this.currentMetrics.cpu) return null;
        const { cpu } = this.currentMetrics;
        const usagePercent = cpu.usagePercent ?? 0;
        const status = this.getStatus(usagePercent);
        
        return (
            <div className="sysmon-metric-card cpu">
                <div className="sysmon-metric-header">
                    <div className="sysmon-metric-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="4" y="4" width="16" height="16" rx="2"/>
                            <rect x="9" y="9" width="6" height="6"/>
                            <line x1="9" y1="1" x2="9" y2="4"/>
                            <line x1="15" y1="1" x2="15" y2="4"/>
                            <line x1="9" y1="20" x2="9" y2="23"/>
                            <line x1="15" y1="20" x2="15" y2="23"/>
                            <line x1="20" y1="9" x2="23" y2="9"/>
                            <line x1="20" y1="14" x2="23" y2="14"/>
                            <line x1="1" y1="9" x2="4" y2="9"/>
                            <line x1="1" y1="14" x2="4" y2="14"/>
                        </svg>
                    </div>
                    <span className={`sysmon-metric-badge ${status.class}`}>{status.label}</span>
                </div>
                
                {this.renderCircularProgress(usagePercent, 'CPU')}
                
                {cpu.temperature && (
                    <div className="sysmon-temp-display">
                        <svg className={`sysmon-temp-icon ${cpu.temperature > 80 ? 'critical' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
                        </svg>
                        <span className="sysmon-temp-text">Temperature</span>
                        <span className="sysmon-temp-value">{cpu.temperature}°C</span>
                    </div>
                )}
                
                {cpu.loadAverage && cpu.loadAverage.length >= 3 && (
                    <div className="sysmon-info-grid">
                        <div className="sysmon-info-item">
                            <div className="sysmon-info-label">Load 1m</div>
                            <div className="sysmon-info-value">{cpu.loadAverage[0]?.toFixed(2) || '--'}</div>
                        </div>
                        <div className="sysmon-info-item">
                            <div className="sysmon-info-label">Load 5m</div>
                            <div className="sysmon-info-value">{cpu.loadAverage[1]?.toFixed(2) || '--'}</div>
                        </div>
                        <div className="sysmon-info-item">
                            <div className="sysmon-info-label">Load 15m</div>
                            <div className="sysmon-info-value">{cpu.loadAverage[2]?.toFixed(2) || '--'}</div>
                        </div>
                    </div>
                )}
                
                {cpu.info && (
                    <div className="sysmon-cpu-info">
                        <div className="sysmon-cpu-model">{cpu.info.brand}</div>
                        <div className="sysmon-cpu-cores">{cpu.info.physicalCores} cores / {cpu.info.cores} threads @ {cpu.info.speed}GHz</div>
                    </div>
                )}
            </div>
        );
    }

    private renderMemoryCard(): React.ReactNode {
        if (!this.currentMetrics || !this.currentMetrics.memory) return null;
        const { memory } = this.currentMetrics;
        const usagePercent = memory.usagePercent ?? 0;
        const status = this.getStatus(usagePercent);
        
        return (
            <div className="sysmon-metric-card memory">
                <div className="sysmon-metric-header">
                    <div className="sysmon-metric-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="6" width="20" height="12" rx="2"/>
                            <line x1="6" y1="10" x2="6" y2="10"/>
                            <line x1="10" y1="10" x2="10" y2="10"/>
                            <line x1="14" y1="10" x2="14" y2="10"/>
                            <line x1="18" y1="10" x2="18" y2="10"/>
                        </svg>
                    </div>
                    <span className={`sysmon-metric-badge ${status.class}`}>{status.label}</span>
                </div>
                
                {this.renderCircularProgress(memory.usagePercent, 'Memory')}
                
                <div className="sysmon-progress-container">
                    <div className="sysmon-progress-header">
                        <span>Used</span>
                        <span>{this.formatBytes(memory.used)} / {this.formatBytes(memory.total)}</span>
                    </div>
                    <div className="sysmon-progress-bar">
                        <div 
                            className="sysmon-progress-fill"
                            style={{ width: `${memory.usagePercent}%` }}
                        />
                    </div>
                </div>
                
                {memory.swapTotal && memory.swapTotal > 0 && (
                    <div className="sysmon-swap-section">
                        <div className="sysmon-swap-header">
                            <span className="sysmon-swap-label">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M17 1l4 4-4 4"/>
                                    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                                    <path d="M7 23l-4-4 4-4"/>
                                    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                                </svg>
                                Swap Memory
                            </span>
                            <span className="sysmon-swap-value">{memory.swapPercent?.toFixed(0)}%</span>
                        </div>
                        <div className="sysmon-progress-bar">
                            <div 
                                className="sysmon-progress-fill"
                                style={{ width: `${memory.swapPercent || 0}%` }}
                            />
                        </div>
                    </div>
                )}
            </div>
        );
    }

    private renderDiskCard(): React.ReactNode {
        if (!this.currentMetrics || !this.currentMetrics.disk) return null;
        const { disk } = this.currentMetrics;
        const selectedDisk = this.disks[this.selectedDiskIndex] || { fs: 'N/A', mount: '/' };
        const status = disk.usagePercent >= 90 ? { label: 'Critical', class: 'sysmon-text-danger' } : 
                      disk.usagePercent >= 70 ? { label: 'Warning', class: 'sysmon-text-warning' } : 
                      { label: 'Good', class: 'sysmon-text-success' };
        
        return (
            <div className="sysmon-metric-card disk">
                <div className="sysmon-metric-header">
                    <div className="sysmon-metric-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <ellipse cx="12" cy="12" rx="10" ry="10"/>
                            <path d="M12 2a10 10 0 0 1 10 10"/>
                            <circle cx="12" cy="12" r="3"/>
                        </svg>
                    </div>
                    <span className={`sysmon-metric-badge ${status.class}`}>{status.label}</span>
                </div>
                
                <div className="sysmon-disk-selector" style={{ marginBottom: '16px' }}>
                    <button 
                        className={`sysmon-disk-trigger ${this.showDiskDropdown ? 'open' : ''}`}
                        onClick={() => { this.showDiskDropdown = !this.showDiskDropdown; this.update(); }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="18" height="18" rx="2"/>
                            <path d="M3 9h18"/>
                        </svg>
                        {selectedDisk.fs} 
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                    </button>
                    
                    {this.showDiskDropdown && (
                        <div className="sysmon-disk-dropdown">
                            {this.disks.map((d, i) => (
                                <div 
                                    key={i}
                                    className={`sysmon-disk-option ${i === this.selectedDiskIndex ? 'active' : ''}`}
                                    onClick={() => this.selectDisk(i)}
                                >
                                    <div className="sysmon-disk-option-fs">{d.fs}</div>
                                    <div className="sysmon-disk-option-info">
                                        {this.formatBytes(d.size)} • {d.mount}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                
                {this.renderCircularProgress(disk.usagePercent, 'Disk')}
                
                <div className="sysmon-info-grid">
                    <div className="sysmon-info-item">
                        <div className="sysmon-info-label">Used</div>
                        <div className="sysmon-info-value">{this.formatBytes(disk.used)}</div>
                    </div>
                    <div className="sysmon-info-item">
                        <div className="sysmon-info-label">Free</div>
                        <div className="sysmon-info-value">{this.formatBytes(disk.free)}</div>
                    </div>
                    <div className="sysmon-info-item">
                        <div className="sysmon-info-label">Total</div>
                        <div className="sysmon-info-value">{this.formatBytes(disk.total)}</div>
                    </div>
                </div>
            </div>
        );
    }

    private renderNetworkCard(): React.ReactNode {
        if (!this.currentMetrics || !this.currentMetrics.network) return null;
        const { network } = this.currentMetrics;
        
        return (
            <div className="sysmon-metric-card network">
                <div className="sysmon-metric-header">
                    <div className="sysmon-metric-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
                            <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
                            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                            <line x1="12" y1="20" x2="12.01" y2="20"/>
                        </svg>
                    </div>
                    <span className="sysmon-metric-badge">Active</span>
                </div>
                
                <div className="sysmon-metric-value-section" style={{ textAlign: 'center', marginBottom: '16px' }}>
                    <div className="sysmon-metric-label">Network Activity</div>
                </div>
                
                <div className="sysmon-network-stats">
                    <div className="sysmon-network-stat">
                        <div className="sysmon-network-icon download">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                        </div>
                        <div className="sysmon-network-stat-label">Download</div>
                        <div className="sysmon-network-stat-value">{this.formatSpeed(network.downloadSpeed)}</div>
                    </div>
                    
                    <div className="sysmon-network-stat">
                        <div className="sysmon-network-icon upload">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="17 8 12 3 7 8"/>
                                <line x1="12" y1="3" x2="12" y2="15"/>
                            </svg>
                        </div>
                        <div className="sysmon-network-stat-label">Upload</div>
                        <div className="sysmon-network-stat-value">{this.formatSpeed(network.uploadSpeed)}</div>
                    </div>
                </div>
                
                <div className="sysmon-network-total">
                    Total Traffic: ↓ {this.formatBytes(network.bytesReceived)} • ↑ {this.formatBytes(network.bytesSent)}
                </div>
                
                {network.interfaceName && (
                    <div className="sysmon-network-interface">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                            <line x1="8" y1="21" x2="16" y2="21"/>
                            <line x1="12" y1="17" x2="12" y2="21"/>
                        </svg>
                        {network.interfaceName}
                    </div>
                )}
            </div>
        );
    }

    private renderCircularProgress(percent: number, label: string): React.ReactNode {
        const radius = 50;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (Math.min(100, Math.max(0, percent)) / 100) * circumference;
        
        return (
            <div className="sysmon-circular-progress">
                <svg width="120" height="120" viewBox="0 0 120 120">
                    <circle
                        className="sysmon-circular-bg"
                        cx="60"
                        cy="60"
                        r={radius}
                    />
                    <circle
                        className="sysmon-circular-fill"
                        cx="60"
                        cy="60"
                        r={radius}
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                    />
                </svg>
                <div className="sysmon-circular-text">
                    <div className="sysmon-circular-value">{percent.toFixed(0)}%</div>
                    <div className="sysmon-circular-label">{label}</div>
                </div>
            </div>
        );
    }

    private renderGraphsSection(): React.ReactNode {
        if (!this.historicalData || !this.currentMetrics) return null;
        const currentCpu = this.currentMetrics.cpu.usagePercent || 0;
        const currentMemory = this.currentMetrics.memory.usagePercent || 0;
        
        return (
            <div className="sysmon-graphs-section">
                <div className="sysmon-graph-card">
                    <div className="sysmon-graph-header">
                        <div className="sysmon-graph-title">
                            <div className="sysmon-graph-icon cpu">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="4" y="4" width="16" height="16" rx="2"/>
                                    <rect x="9" y="9" width="6" height="6"/>
                                </svg>
                            </div>
                            CPU History
                        </div>
                        <span className="sysmon-graph-current cpu">{currentCpu.toFixed(1)}%</span>
                    </div>
                    <div 
                        ref={el => this.renderSparkline(el, this.historicalData?.cpu || [], '#10b981')} 
                        className="sysmon-graph-container" 
                    />
                </div>
                
                <div className="sysmon-graph-card">
                    <div className="sysmon-graph-header">
                        <div className="sysmon-graph-title">
                            <div className="sysmon-graph-icon memory">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="2" y="6" width="20" height="12" rx="2"/>
                                </svg>
                            </div>
                            Memory History
                        </div>
                        <span className="sysmon-graph-current memory">{currentMemory.toFixed(1)}%</span>
                    </div>
                    <div 
                        ref={el => this.renderSparkline(el, this.historicalData?.memory || [], '#3b82f6')} 
                        className="sysmon-graph-container" 
                    />
                </div>
            </div>
        );
    }

    private renderSparkline(element: HTMLElement | null, data: number[], color: string): void {
        if (!element || !this.Plotly || !this.historicalData) return;

        const plotData = [{
            x: this.historicalData.timestamps.map(t => new Date(t)),
            y: data,
            type: 'scatter',
            mode: 'lines',
            fill: 'tozeroy',
            line: { color: color, width: 2, shape: 'spline' },
            fillcolor: color + '15'
        }];

        const layout = {
            margin: { t: 5, r: 5, b: 30, l: 40 },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            autosize: true,
            font: { color: 'var(--theia-foreground)', size: 11, family: 'var(--theia-ui-font-family)' },
            xaxis: { 
                showgrid: false, 
                zeroline: false, 
                tickformat: '%H:%M:%S', 
                nticks: 4,
                automargin: true
            },
            yaxis: { 
                showgrid: true, 
                gridcolor: 'var(--theia-panel-border)',
                zeroline: false, 
                range: [0, 100], 
                ticksuffix: '%', 
                nticks: 4,
                automargin: true
            }
        };

        const config = { displayModeBar: false, staticPlot: true, responsive: true };
        this.Plotly.newPlot(element, plotData, layout, config);
        
        setTimeout(() => {
            if (element) {
                this.Plotly.Plots.resize(element);
            }
        }, 100);
    }

    private getStatus(value: number): { label: string; class: string } {
        if (value >= 90) return { label: 'Critical', class: 'sysmon-text-danger' };
        if (value >= 70) return { label: 'High', class: 'sysmon-text-warning' };
        return { label: 'Normal', class: 'sysmon-text-success' };
    }

    private formatBytes(bytes: number): string {
        if (!bytes || bytes === 0) return '0 GB';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1000) return `${(gb / 1024).toFixed(2)} TB`;
        if (gb >= 100) return `${Math.round(gb)} GB`;
        return `${gb.toFixed(1)} GB`;
    }

    private formatSpeed(bytesPerSecond: number): string {
        if (!bytesPerSecond || bytesPerSecond < 1024) {
            return `${Math.round(bytesPerSecond || 0)} B/s`;
        } else if (bytesPerSecond < 1024 * 1024) {
            return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
        } else {
            return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
        }
    }

    private formatUptime(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes}m`;
    }

    private renderSystemInfo(): React.ReactNode {
        if (!this.currentMetrics?.system) return null;
        const { system } = this.currentMetrics;
        
        return (
            <div className="sysmon-system-section">
                <div className="sysmon-section-title">System Information</div>
                <div className="sysmon-system-grid">
                    <div className="sysmon-system-item">
                        <div className="sysmon-system-label">Hostname</div>
                        <div className="sysmon-system-value">{system.hostname}</div>
                    </div>
                    <div className="sysmon-system-item">
                        <div className="sysmon-system-label">Operating System</div>
                        <div className="sysmon-system-value">{system.distro} {system.release}</div>
                    </div>
                    <div className="sysmon-system-item">
                        <div className="sysmon-system-label">Platform</div>
                        <div className="sysmon-system-value">{system.platform} ({system.arch})</div>
                    </div>
                    {system.processCount !== undefined && (
                        <div className="sysmon-system-item">
                            <div className="sysmon-system-label">Processes</div>
                            <div className="sysmon-system-value">{system.processCount.toLocaleString()}</div>
                        </div>
                    )}
                </div>
            </div>
        );
    }
}
