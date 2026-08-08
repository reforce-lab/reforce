// `.reforce` 下的 lease 记录、事务 journal 和 generated manifest 都是从磁盘读回的 JSON：可能被手改，
// 也可能来自版本错配的写入方。三处解析器共享同一条准入规则——required 必须全部到场，且不接受任何
// 计划外的键（多出来的键意味着写入方与本进程理解的 schema 不同，只能整条拒绝，不能忽略后继续用）。
export function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
