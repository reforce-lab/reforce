// compiler 用这个序决定 manifest.json 里 bean / import / diagnostic 的字段顺序，CLI 再按同一个
// 序算 aggregate hash 与 dev build id，并校验 manifest 的 key 集合。两端的序一旦分叉，信任边界
// 就会误判，所以它必须跨机器、跨 Node/Bun 构建完全一致。
//
// 不得改用 localeCompare / Intl.Collator / radashi 的 alphabetical：三者都走 ICU，结果随 locale
// 和运行时内置的 ICU 数据版本变化。JS 的 `<` 对字符串是规范定义的 UTF-16 code unit 比较
// (ECMA-262 IsStringLessThan)，无环境依赖。
export function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
