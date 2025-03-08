import { injectable } from "inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node";
import * as express from "express";
import * as path from "path";

@injectable()
export class PWABackendService implements BackendApplicationContribution {
  configure(app: express.Application): void {
    const staticFilesPath = path.resolve(__dirname, "../../../../extensions/nukelab-pwa/src/");
    app.use(
      "/manifest.json",
      express.static(path.join(staticFilesPath, "manifest.json"))
    );
    app.use(
      "/service-worker.js",
      express.static(path.join(staticFilesPath, "service-worker.js"))
    );
  }
}
