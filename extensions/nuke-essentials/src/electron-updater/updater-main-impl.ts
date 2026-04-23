import { injectable } from '@theia/core/shared/inversify';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { NukeUpdaterService, NukeUpdaterStatus } from '../common/updater-protocol';

const { autoUpdater } = require('electron-updater');

@injectable()
export class NukeUpdaterMainImpl implements NukeUpdaterService, ElectronMainApplicationContribution {

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
    }

    onStart(): void {
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch((err: Error) => {
                console.error('[NukeUpdater] Check failed:', err.message);
            });
        }, 5000);
    }

    checkForUpdates(): void {
        autoUpdater.checkForUpdates().catch((err: Error) => {
            console.error('[NukeUpdater] Manual check failed:', err.message);
        });
    }

    restartToUpdate(): void {
        autoUpdater.quitAndInstall();
    }

    getStatus(): Promise<NukeUpdaterStatus> {
        return Promise.resolve({ readyToUpdate: this.readyToUpdate });
    }
}
