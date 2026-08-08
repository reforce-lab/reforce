# @reforce/primitives

多个 workspace 共用的底层原语。根入口是纯函数；终端相关的三个子路径另有一套规则，见下。

## 准入规则

一个函数要放进根入口（`@reforce/primitives`），必须同时满足：

- 纯函数：同样输入永远同样输出，无状态、幂等。
- 无 I/O：不碰文件系统、网络、进程、时钟、随机数、环境变量。只允许 `node:path` 这类纯计算内置模块。
- 零第三方运行时依赖。
- 至少两个 workspace 真的在用，或者两端的实现必须保持一致（例如 compiler 产出、CLI 校验）。

**三个终端子路径是刻意的例外**（`./terminal`、`./stack-frames`、`./render-mode`，#347）：它们**读进程环境**——`terminal` 看 `stream.isTTY` 与 `columns`，`styleText` 认 `NO_COLOR` / `FORCE_COLOR`，`render-mode` 认几个环境变量（虽然值由 `input.env` 传入，词汇表是它定的）。所以它们不许从根入口导出，只能按子路径引，理由是「谁在读环境」在 import 那一行就看得见。

它们放这里不是因为满足了纯函数规则，而是因为**依赖方向**：`@reforce/logging` 与 `@reforce/cli` 都要用，而让 logging 依赖 `@reforce/runtime` 正是 #347 要拆掉的那条边。四个消费方全是构建期或引导期的 node 工具，web 系一个都不依赖 primitives，`node:util` / `node:stream` 因此没有实际代价（后者是 type-only，构建后擦除）。

其余不满足的一律留在各自的 package 里。这个包不是共享工具的收纳处——`shared` / `common` 那种没有准入门槛的包会在几个月内变成垃圾桶，`primitives` 这个名字本身就是门槛。

## 为什么这些东西必须共享

`compareUtf16CodeUnits` 和 `toPortablePath` 都直接决定生成物的字节。compiler 按它们排序和归一化后写出 `manifest.json`，CLI 再按同一套规则算 aggregate hash、dev build id 并校验 manifest。两端只要有一端改了规则，信任边界就会误判——所以它们不能是"各写一份长得一样的代码"。

`isPathContained` / `isPathStrictlyContained` 决定的是"这条路径算不算越界"。它们此前在 cli、compiler、tooling-testing 里各有实现，而且两种极性混在一起：有的把 `target === boundary` 判为越界，有的判为放行。删除操作用错极性就会递归删掉用户项目根（Issue #55），所以两种极性各留一个自解释的名字，一起放在这里。
