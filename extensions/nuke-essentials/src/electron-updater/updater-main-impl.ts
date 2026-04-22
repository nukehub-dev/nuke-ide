import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { injectable } from '@theia/core/shared/inversify';
import { ipcMain } from 'electron';

const { autoUpdater } = require('electron-updater');

@injectable()
export class NukeUpdaterMainImpl implements ElectronMainApplicationContribution {

    private readyToUpdate = false;

    constructor() {
        autoUpdater.autoDownload = true;
        autoUpdater.allowDowngrade = false;

        autoUpdater.on('update-available', (info: { version: string }) => {
            console.log(`[NukeUpdater] Update available: ${info.version}`);
        });

        autoUpdater.on('update-downloaded', (info: { version: string }) => {
            console.log(`[NukeUpdater] Update downloaded: ${info.version}`);
            this.readyToUpdate = true;
        });

        autoUpdater.on('error', (err: Error) => {
            console.error('[NukeUpdater] Error:', err.message);
        });

        ipcMain.on('nuke-updater:check', () => {
            autoUpdater.checkForUpdates().catch((err: Error) => {
                console.error('[NukeUpdater] Manual check failed:', err.message);
            });
        });

        ipcMain.on('nuke-updater:restart', () => {
            autoUpdater.quitAndInstall();
        });

        ipcMain.handle('nuke-updater:status', () => {
            return { readyToUpdate: this.readyToUpdate };
        });
    }

    onStart(): void {
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch((err: Error) => {
                console.error('[NukeUpdater] Check failed:', err.message);
            });
        }, 5000);
    }
}
