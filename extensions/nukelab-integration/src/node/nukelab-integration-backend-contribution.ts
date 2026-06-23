import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as express from '@theia/core/shared/express';

export interface NukeLabContext {
    username: string;
    userId: string;
    serverId: string;
    serverName: string;
    labUrl: string;
    dashboardUrl: string;
    publicUrl: string;
}

@injectable()
export class NukeLabIntegrationBackendContribution implements BackendApplicationContribution {
    configure(app: express.Application): void {
        app.get('/api/nukelab/context', (_req, res) => {
            const username = process.env.NUKELAB_USERNAME || '';
            const userId = process.env.NUKELAB_USER_ID || '';
            const serverId = process.env.NUKELAB_SERVER_ID || '';
            const serverName = process.env.NUKELAB_SERVER_NAME || '';

            const publicUrl = this.getPublicUrl();
            const labUrl = username && serverName ? `${publicUrl}/user/${username}/${serverName}` : '';
            const dashboardUrl = publicUrl;

            res.json({
                username,
                userId,
                serverId,
                serverName,
                labUrl,
                dashboardUrl,
                publicUrl,
            } as NukeLabContext);
        });
    }

    private getPublicUrl(): string {
        if (process.env.NUKELAB_PUBLIC_URL) {
            return process.env.NUKELAB_PUBLIC_URL.replace(/\/$/, '');
        }
        const protocol = process.env.NUKELAB_PROTOCOL || 'http';
        const host = process.env.NUKELAB_HOST || process.env.HOSTNAME || 'localhost';
        const port = process.env.NUKELAB_PORT || '8080';
        return `${protocol}://${host}:${port}`;
    }
}
