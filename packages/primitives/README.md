# @reforce/primitives

多个 workspace 共用的底层纯函数原语。

## 准入规则

一个函数要放进这里，必须同时满足：

- 纯函数：同样输入永远同样输出，无状态、幂等。
- 无 I/O：不碰文件系统、网络、进程、时钟、随机数、环境变量。只允许 `node:path` 这类纯计算内置模块。
- 零第三方运行时依赖。
- 至少两个 workspace 真的在用，或者两端的实现必须保持一致（例如 compiler 产出、CLI 校验）。

不满足的一律留在各自的 package 里。这个包不是共享工具的收纳处——`shared` / `common` 那种没有准入门槛的包会在几个月内变成垃圾桶，`primitives` 这个名字本身就是门槛。

## 为什么这些东西必须共享

`compareUtf16CodeUnits` 和 `toPortablePath` 都直接决定生成物的字节。compiler 按它们排序和归一化后写出 `manifest.json`，CLI 再按同一套规则算 aggregate hash、dev build id 并校验 manifest。两端只要有一端改了规则，信任边界就会误判——所以它们不能是"各写一份长得一样的代码"。
