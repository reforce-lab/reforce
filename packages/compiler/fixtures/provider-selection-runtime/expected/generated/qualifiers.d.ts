import type { QualifiedBean } from "@reforce/context";
import type { DefaultPort as InterfaceType0 } from "../../src/application.js";
import type { UniquePort as InterfaceType1 } from "../../src/application.js";

declare module "../../src/application.js" {
  namespace DefaultPort {
    type Fallback = QualifiedBean<InterfaceType0, "src/application.ts#FallbackProvider">;
    type Preferred = QualifiedBean<InterfaceType0, "src/application.ts#PreferredProvider">;
  }

  namespace UniquePort {
    type UniqueProvider = QualifiedBean<InterfaceType1, "src/application.ts#UniqueProvider">;
  }
}
