import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await chmod(fileURLToPath(new URL("../dist/reforce.js", import.meta.url)), 0o755);
