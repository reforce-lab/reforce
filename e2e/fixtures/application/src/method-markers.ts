import { defineMethodMarker } from "@reforce/core";

// 方法级标记（ADR 0008 AM1，#202）：编译期提取字面量进织入表，行为由 @Interceptor 绑定。
export const Audited = defineMethodMarker<{ label: string }>("audited");
