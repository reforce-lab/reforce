export async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    // 挂起的 promise 不该把 CLI 多吊住整个超时预算，所以定时器 unref。代价是它自己撑不住 event
    // loop：调用方必须另有 ref 住的句柄（当前所有调用点都在等一个活着的子进程），否则进程会在
    // 超时触发前直接退出，这条 reject 永远不会发生。
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
