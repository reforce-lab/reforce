export function renderProductionEntry(): string {
  return `import { runProductionApplication } from "#reforce-production-runtime";

const { bootstrap } = await import("reforce:application-bootstrap");
await runProductionApplication(bootstrap);
`;
}
