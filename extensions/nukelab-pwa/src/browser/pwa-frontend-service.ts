import { injectable } from 'inversify';
import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';

@injectable()
export class PWAFrontendService implements FrontendApplicationContribution {
    onStart(app: FrontendApplication): void {
        this.addManifest();
        this.registerServiceWorker();
    }

    private addManifest(): void {
        if (!document.querySelector('link[rel="manifest"]')) {
            const link = document.createElement('link');
            link.rel = 'manifest';
            link.href = '/hub/static/manifest.json';
            document.head.appendChild(link);
        }
    }

    private registerServiceWorker(): void {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/hub/static/service-worker.js')
                .then(reg => console.log('Service Worker registered:', reg))
                .catch(err => console.error('Service Worker registration failed:', err));
        }
    }
}
