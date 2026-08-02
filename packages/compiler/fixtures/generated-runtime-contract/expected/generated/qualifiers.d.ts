import type { QualifiedBean } from "@reforce/context";
import type { AlphaPort as InterfaceType0 } from "../../src/contracts.js";
import type { BetaPort as InterfaceType1 } from "../../src/contracts.js";

declare module "../../src/contracts.js" {
  namespace AlphaPort {
    type AlphaService = QualifiedBean<InterfaceType0, "src/application.ts#AlphaService">;
  }

  namespace BetaPort {
    type BetaService = QualifiedBean<InterfaceType1, "src/application.ts#BetaService">;
  }
}
