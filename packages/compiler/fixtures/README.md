# Compiler fixtures

Every directory is named after the behavior it proves and has one shape:

```text
<case>/
├── project/
└── expected/
    ├── source-ir.json
    ├── diagnostics.json
    └── generated/
        ├── beans.ts
        ├── qualifiers.d.ts
        ├── manifest.json
        └── bootstrap.ts
```

`source-ir.json` is the ordered array of complete Source IR units. A parser failure may omit it.
`diagnostics.json` is the complete ordered diagnostic array and is `[]` on success. Project-local
native paths are serialized as `<projectRoot>/...` so the same golden works on every platform. A
Compiler failure has no `generated/` directory. A Compiler success has exactly the four files shown
above, compared byte for byte.

Frontend cases have no direct `tsconfig*.json`. Their TypeScript files are parsed unchanged by both
adapters. `project/input.json` is allowed only for byte-sensitive source text whose line endings
cannot depend on Git checkout conversion; it contains exactly `file`, `sourceKind`, and `sourceText`.
Compiler cases have one or more direct `tsconfig*.json` and run through project resolution before
compilation. Intentionally invalid project sources are excluded from repository formatting. Generated
goldens are also excluded because their unformatted bytes are the contract; the corpus test compares
them byte for byte. Source IR, diagnostics, updater, README, and tests remain under normal checks.

Refresh all goldens from the repository root with:

```bash
bun run --cwd packages/compiler-babel fixtures:update
```

The updater first requires Babel and Yuku to return deeply identical frontend results. It then
writes Source IR and frontend diagnostics for frontend cases, or runs the two-stage Compiler and
writes Compiler diagnostics plus the exact generated file set for Compiler cases.
