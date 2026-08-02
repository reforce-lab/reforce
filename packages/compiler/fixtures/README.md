# Compiler fixtures

Fixtures live beside Compiler because they model complete application projects: tsconfig discovery,
multi-file linking, monorepo boundaries, generated runtime execution, and platform path behavior.
Each directory is named after the behavior it supports and contains only its `project/` input.

Expected behavior is asserted directly in the test that consumes the fixture. This keeps the relevant
diagnostic, manifest field, generated invariant, or runtime observation visible at the assertion site
instead of duplicating the complete Source IR and generated tree in snapshots.

Yuku parser-to-IR behavior that needs only one source unit stays inline in
`packages/compiler/src/parser/parse-source.spec.ts`; it does not need an application fixture here.
