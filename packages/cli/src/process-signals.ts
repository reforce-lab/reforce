// Windows console applications never receive SIGTERM: the terminal only raises SIGINT (Ctrl-C) and
// SIGBREAK (Ctrl-Break) there, so a SIGTERM listener would silently never fire. Every CLI process
// that wants an orderly shutdown has to watch the same platform-dependent pair, which is why the
// list lives here instead of being restated per caller.
//
// This module only answers "which signals do we listen for". Which signal a parent sends to ask a
// child to stop, and whether a signal can be delivered to that child at all, are separate decisions
// that stay with their callers.
export function installTerminationSignalHandlers(
  onSignal: (signal: NodeJS.Signals) => void,
): () => void {
  const signals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const installed = signals.map((signal) => {
    const handler = () => onSignal(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of installed) {
      process.off(signal, handler);
    }
  };
}
