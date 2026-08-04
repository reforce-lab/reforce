import { writeFileSync } from "node:fs";
import { Injectable, type OnContextStart } from "@reforce/context";
import type { FixtureServerConfig } from "@/server-config";

@Injectable()
export class ConfigProbe implements OnContextStart {
  constructor(readonly config: FixtureServerConfig) {}

  onContextStart(): void {
    const path = process.env.REFORCE_E2E_CONFIG_OUT;
    if (path !== undefined) {
      writeFileSync(path, `${this.config.host}:${this.config.port}\n`, "utf8");
    }
  }
}
