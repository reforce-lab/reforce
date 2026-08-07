// 排序方向：任何一个列表接口都要它，不属于哪一个模块，所以跟 pagination.dto.ts 放在一起
// ——它们是同一个概念的两块。
export const SORT_ORDERS = ["asc", "desc"] as const;

export type SortOrder = (typeof SORT_ORDERS)[number];
