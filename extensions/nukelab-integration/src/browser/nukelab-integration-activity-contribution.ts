import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { Endpoint } from '@theia/core/lib/browser/endpoint';

// How often the heartbeat checks whether an activity ping should be sent.
const ACTIVITY_PING_INTERVAL_MS = 60_000;
// Only interactions within this window count as activity. Kept below the
// minimum idle_shutdown_timeout (5 minutes, enforced by the NukeLab hub) so
// the final ping after the user's last interaction always lands before the
// server can be stopped.
const ACTIVITY_INPUT_WINDOW_MS = 4 * 60_000;
// Deliberate input only — passive mouse movement is not activity.
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

/**
 * Reports real user activity in the IDE to the NukeLab hub's idle-shutdown
 * tracking. Editor and terminal traffic runs over long-lived websockets that
 * the hub cannot see, so without this an actively-used server looks idle once
 * the hub SPA is closed. Each ping traverses the container nginx auth sidecar,
 * which reports the request time to the hub as server activity.
 *
 * Pings are gated on recent, deliberate interaction: an IDE tab left open but
 * untouched must not keep the server alive forever.
 */
@injectable()
export class NukeLabActivityContribution implements FrontendApplicationContribution {
    protected lastInteractionAt: number | undefined;
    protected intervalHandle: number | undefined;
    protected readonly interactionListener = (): void => {
        this.lastInteractionAt = Date.now();
    };

    @postConstruct()
    protected init(): void {
        // Opening the IDE is itself a deliberate interaction.
        this.interactionListener();
        for (const event of INPUT_EVENTS) {
            window.addEventListener(event, this.interactionListener, { passive: true });
        }
        this.intervalHandle = window.setInterval(() => this.maybePing(), ACTIVITY_PING_INTERVAL_MS);
    }

    onStop(_app: FrontendApplication): void {
        window.clearInterval(this.intervalHandle);
        for (const event of INPUT_EVENTS) {
            window.removeEventListener(event, this.interactionListener);
        }
    }

    protected maybePing(): void {
        if (document.visibilityState !== 'visible') {
            return;
        }
        if (this.lastInteractionAt === undefined || Date.now() - this.lastInteractionAt > ACTIVITY_INPUT_WINDOW_MS) {
            return;
        }
        // Resolve against the current page path so the request stays under the
        // Traefik route prefix in the NukeLab deployment; an origin-rooted URL
        // would hit the hub API instead (see extensions/AGENTS.md). Outside
        // NukeLab this endpoint does not exist and the ping harmlessly 404s.
        const endpoint = new Endpoint({ path: '/api/nukelab/activity' }).getRestUrl().toString();
        fetch(endpoint, { method: 'POST' }).catch(() => {
            // Best-effort: a failed ping must never disturb the session.
        });
    }
}
