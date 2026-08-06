// 事务拦截器只出生成入口不出根入口（#204 定案 6）：它由编译器合成注册、生成的 beans.ts
// new，用户不手声明；测试替换走 replaceCreate 的 beanId，不需要类本身。
export { TransactionInterceptor } from "@/interceptor";
