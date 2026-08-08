# @reforce/starter-meta

`reforce-meta.json` 的契约本体：类型、parser、JSON Schema，以及一个不依赖框架的独立校验器。

**为什么它是独立包**：一个应用装一个编译器 + N 个各自发布节奏的 starter。写适配的人需要在自己
的 CI 里验证 meta，而 `@reforce/compiler` 当不了那个 devDependency——它把 typescript 钉在精确
nightly 加 tsgo 原生二进制。本包零依赖（只有 `@swc/helpers` 这个运行时垫片），装它不等于装框架。

```bash
npx reforce-meta-check ./packages/my-starter
```

## 准入的唯一真相是 `parseStarterMeta`

`schema.json` 是**宽松近似**，定位是编辑器补全：跨字段约束（如「`provides` 必须含自身 id」、
「`runtimeExport.module` 必须留在本包内」）用 JSON Schema 表达不出来。两者用同一批 fixture 对拍，
防止双事实源漂移。
