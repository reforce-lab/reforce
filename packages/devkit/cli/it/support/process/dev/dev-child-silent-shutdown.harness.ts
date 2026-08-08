// 模拟「跑完自己的关闭流程后干净退出、但 ack 从未送达 parent」的子进程（Issue #32）。
const onMessage = (message: unknown) => {
  if (typeof message !== "object" || message === null) {
    return;
  }
  if (Reflect.get(message, "type") !== "reforce:shutdown") {
    return;
  }
  process.exit(0);
};
process.on("message", onMessage);
process.send?.({ type: "reforce:dev-ready" });
