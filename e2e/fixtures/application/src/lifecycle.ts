import { appendFileSync, writeFileSync } from "node:fs";
import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/core";

@Injectable()
export class ApplicationDependencyProbe {}

@Injectable()
export class ApplicationLifecycleProbe implements OnContextStart, OnContextClose {
  constructor(readonly dependency: ApplicationDependencyProbe) {}

  onContextStart(): void {
    const path = process.env.REFORCE_E2E_READY;
    const marker = process.env.REFORCE_E2E_MARKER ?? "application";
    if (path !== undefined) {
      writeFileSync(path, `${marker}:ready\n`, "utf8");
    }
  }

  onContextClose(): void {
    const path = process.env.REFORCE_E2E_CLOSED;
    const marker = process.env.REFORCE_E2E_MARKER ?? "application";
    if (path !== undefined) {
      appendFileSync(path, `${marker}:closed\n`, "utf8");
    }
  }
}
