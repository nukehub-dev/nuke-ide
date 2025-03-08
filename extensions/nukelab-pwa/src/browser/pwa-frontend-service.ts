import { injectable } from 'inversify';
import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';

@injectable()
export class PWAFrontendService implements FrontendApplicationContribution {
    onStart(app: FrontendApplication): void {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/service-worker.js')
                .then(reg => console.log('Service Worker registered:', reg))
                .catch(err => console.error('Service Worker registration failed:', err));
        }
    }
}