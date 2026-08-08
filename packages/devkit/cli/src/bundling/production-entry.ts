export function renderProductionEntry(): string {
  return `import { runProductionApplication } from "reforce:production-runtime";

const generated = await import("reforce:application-bootstrap");
await runProductionApplication(generated.bootstrap, {
  frameworkLogging: generated.frameworkLogging,
});
`;
}
