import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { NukeLabContext } from '../common/nukelab-integration-protocol';

// After a successful renewal, 401s arriving within this window are genuine
// auth failures (the cookie is fresh), so they must not trigger another
// renewal attempt.
const RENEWAL_GRACE_MS = 30_000;

/**
 * Keeps the NukeLab server access token alive while the IDE is open.
 *
 * The hub mints the `nukelab_server_token` cookie (5 minute TTL) only when the
 * gateway page opens or reloads; nothing refreshes it during an IDE session.
 * Editor and terminal traffic runs over a long-lived WebSocket, so an expired
 * cookie goes unnoticed until a plain REST call — file downloads and uploads
 * via `/files` — is rejected with a 401 by the container's auth sidecar.
 *
 * This contribution wraps `window.fetch`: when a same-origin request is
 * answered with 401, it silently re-mints the cookie via the hub API (the IDE
 * page is same-origin with the hub SPA, so the hub JWT is readable from
 * localStorage) and retries the request exactly once. Retrying any HTTP
 * method is safe: the 401 came from the sidecar, so the request never
 * reached the application.
 */
@injectable()
export class NukeLabSessionRenewalContribution implements FrontendApplicationContribution {
    protected serverId: string | undefined;
    protected originalFetch: typeof window.fetch | undefined;
    protected renewalInFlight: Promise<boolean> | undefined;
    protected lastRenewalAt = 0;
    protected readonly retriedRequests = new WeakSet<Request>();

    initialize(): void {
        void this.activate();
    }

    onStop(_app: FrontendApplication): void {
        if (this.originalFetch) {
            window.fetch = this.originalFetch;
            this.originalFetch = undefined;
        }
    }

    protected async activate(): Promise<void> {
        try {
            // Resolve against the current page path so the request stays under
            // the Traefik route prefix in the NukeLab deployment (see
            // extensions/AGENTS.md). Outside NukeLab this endpoint does not
            // exist and renewal stays disabled.
            const endpoint = new Endpoint({ path: '/api/nukelab/context' }).getRestUrl().toString();
            const response = await window.fetch(endpoint);
            if (!response.ok) {
                return;
            }
            const context = (await response.json()) as NukeLabContext;
            if (!context.serverId) {
                return;
            }
            this.serverId = context.serverId;
            this.installFetchWrapper();
        } catch {
            // Best-effort: renewal problems must never break the session.
        }
    }

    protected installFetchWrapper(): void {
        this.originalFetch = window.fetch.bind(window);
        const original = this.originalFetch;
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const response = await original(input, init);
            if (response.status !== 401 || (input instanceof Request && this.retriedRequests.has(input))) {
                return response;
            }
            if (Date.now() - this.lastRenewalAt < RENEWAL_GRACE_MS) {
                // The cookie was just renewed, so this 401 is genuine.
                return response;
            }
            if (!(await this.renewToken())) {
                return response;
            }
            if (input instanceof Request) {
                this.retriedRequests.add(input);
            }
            return original(input, init);
        };
    }

    protected renewToken(): Promise<boolean> {
        if (!this.renewalInFlight) {
            this.renewalInFlight = this.doRenewToken().finally(() => {
                this.renewalInFlight = undefined;
            });
        }
        return this.renewalInFlight;
    }

    protected async doRenewToken(): Promise<boolean> {
        try {
            const jwt = localStorage.getItem('nukelab-token');
            const original = this.originalFetch;
            if (!jwt || !this.serverId || !original) {
                return false;
            }
            // Origin-rooted on purpose: this is a hub API route, not an IDE
            // backend route (see extensions/AGENTS.md). The endpoint sets the
            // fresh server cookie on the response.
            const response = await original(`${window.location.origin}/api/servers/${this.serverId}/access-token`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    'Content-Type': 'application/json'
                },
                body: '{}'
            });
            if (!response.ok) {
                return false;
            }
            this.lastRenewalAt = Date.now();
            return true;
        } catch {
            return false;
        }
    }
}
