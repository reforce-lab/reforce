import type { QualifiedBean } from "@reforce/context";
import type { GreetingPort as InterfaceType0 } from "../../src/application.js";

declare module "../../src/application.js" {
  namespace GreetingPort {
    type MessageRepository = QualifiedBean<InterfaceType0, "src/application.ts#MessageRepository">;
  }
}
