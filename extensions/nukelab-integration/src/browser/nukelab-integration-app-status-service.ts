import { injectable, inject } from '@theia/core/shared/inversify';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service';

export const NUKELAB_APP_INSTALLED_KEY = 'nukelabAppInstalled';
export const NUKELAB_APP_STANDALONE_KEY = 'nukelabAppStandalone';

@injectable()
export class NukeLabAppStatusService {

    @inject(ContextKeyService)
    protected readonly contextKeyService: ContextKeyService;

    protected installedKey: ReturnType<ContextKeyService['createKey']> | undefined;
    protected standaloneKey: ReturnType<ContextKeyService['createKey']> | undefined;

    initialize(): void {
        if (typeof window === 'undefined') {
            return;
        }
        this.installedKey = this.contextKeyService.createKey(NUKELAB_APP_INSTALLED_KEY, this.isInstalled());
        this.standaloneKey = this.contextKeyService.createKey(NUKELAB_APP_STANDALONE_KEY, this.isStandalone());

        const mql = window.matchMedia('(display-mode: standalone)');
        const listener = () => this.updateState();
        if (mql.addEventListener) {
            mql.addEventListener('change', listener);
        } else if ((mql as any).addListener) {
            (mql as any).addListener(listener);
        }

        window.addEventListener('appinstalled', () => this.updateState());
    }

    isInstalled(): boolean {
        if (typeof window === 'undefined') {
            return false;
        }
        return this.isStandalone();
    }

    isStandalone(): boolean {
        if (typeof window === 'undefined') {
            return false;
        }
        const standalone = window.matchMedia('(display-mode: standalone)').matches;
        const iosStandalone = 'standalone' in window.navigator && !!(window.navigator as Navigator & { standalone?: boolean }).standalone;
        return standalone || iosStandalone;
    }

    protected updateState(): void {
        this.installedKey?.set(this.isInstalled());
        this.standaloneKey?.set(this.isStandalone());
    }
}
