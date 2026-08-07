import type { CrashLogTarget, FatalLogger, FlushableLoggerFactory } from "@/crash-takeover";
import type { ShutdownLogger } from "@/shutdown-controller";

// 生成的 bootstrap 交给运行时的那一份东西（RFC 0011 C2/C3，#250）。
//
// 两个消费者各自声明了自己用得到的最小形状——崩溃接管只要 fatal 与 flush，关停日志只要
// info——这里用交叉类型把它们合成一个交接口，两个模块因此谁也不必知道对方存在。
//
// 单独成模块而不是挂在 production-runtime 上：dev 与生产走同一条缝（L6 把 HMR 明列为运行期
// 框架输出），dev 反过来 import 生产入口会把依赖方向拧了。
export interface FrameworkLogging extends CrashLogTarget {
  readonly logger: FatalLogger & ShutdownLogger;
  readonly factory: FlushableLoggerFactory;
}
