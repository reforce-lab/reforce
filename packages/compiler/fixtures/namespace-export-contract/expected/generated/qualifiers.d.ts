import type { QualifiedBean } from "@reforce/context";
import type { Port as InterfaceType0 } from "../../src/ports.js";

declare module "../../src/ports.js" {
  namespace Port {
    type Provider = QualifiedBean<InterfaceType0, "src/application.ts#Provider">;
  }
}
