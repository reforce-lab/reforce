import { createApplicationContext } from "@reforce/context/generated-runtime";
import { applicationDefinition } from "./beans.js";

export async function bootstrap() {
  const application = createApplicationContext(applicationDefinition);
  await application.start();
  return application;
}
