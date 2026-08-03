export function renderDevelopmentEntry(): string {
  return `import { createRspackHmrRuntime, runDevelopmentApplication } from "reforce:dev-runtime";

const hot = import.meta.webpackHot;
if (!hot) {
  throw new Error("Reforce development entry requires the Rspack HMR runtime.");
}

// Must stay written exactly like this — on the full \`import.meta.webpackHot\` member expression,
// with a literal specifier, in the module that owns this hot object. rspack rewrites the accepted
// request into a module id at build time by matching that expression shape; going through the
// \`hot\` alias above, or passing a variable from runtime/hmr-manager.ts, leaves the raw string in
// the output and \`_acceptedDependencies\` is then keyed by something no dependency ever matches.
// That is why every update used to propagate past this entry and abort as "not accepted"
// (Issue #46).
import.meta.webpackHot.accept("reforce:application-bootstrap");

process.exitCode = await runDevelopmentApplication({
  hot: createRspackHmrRuntime(hot),
  loadBootstrap: () => import("reforce:application-bootstrap"),
});
`;
}
