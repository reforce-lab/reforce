import type { LeaseParticipant } from "@reforce/runtime/lease-endpoint";
import { isObject } from "radashi";

// 子进程通过 IPC 上报的 participant 会跨进程边界丢掉类型，父子两侧都得重新逐字段校验。
// 这里收敛的是「一个合法 child participant 长什么样」这条规则本身，改字段只需改一处（Issue #35）。
export function parseLeaseParticipant(value: unknown): LeaseParticipant | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const participantToken = Reflect.get(value, "participantToken");
  const host = Reflect.get(value, "host");
  const port = Reflect.get(value, "port");
  const challenge = Reflect.get(value, "challenge");
  const role = Reflect.get(value, "role");
  if (
    typeof participantToken !== "string" ||
    host !== "127.0.0.1" ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    typeof challenge !== "string" ||
    role !== "child"
  ) {
    return undefined;
  }
  return { participantToken, host, port, challenge, role };
}
