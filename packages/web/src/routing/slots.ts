// 槽位透明别名(RFC 0012 S2,#264 决策 4/#274):handler 参数的类型标注是 Web 契约的唯一
// 真相来源,这些别名在类型层完全透明——参数声明什么类型,handler 体内就拿到什么类型;
// 键名、槽位与解码规则全部由编译器从标注静态读出,运行时零反射。
//
// 四个槽位 × 两种形态:
// - 单键:第一实参是字符串字面量键名,第二实参是值类型(缺省 string)。
//   Param<"id", bigint>、Query<"page", number | undefined>、Header<"x-tenant" | undefined>
//   (键名 ∪ undefined = 可选单键,值随之带 undefined)。
// - 契约:第一实参是对象契约,整体解码;第二实参可选投影出单个字段(第四档写法,
//   解码仍按整个契约跑,参数值按键投影)。Param<SnowflakeParams>、Body<CreateUser, "name">。
// Body 的第一实参永远是契约(对象/数组/标量三种根形态,#264「定形」),不参与单键裁决。
//
// 注意:`Body` 与 DOM lib 的全局 `Body` 同名,仅在 script 作用域相撞;模块内具名 import
// 无冲突。

declare const WHOLE: unique symbol;

// 约束哨兵用命名 brand 接口:匿名对象类型会让 TS2344 的约束文案丢掉可读名字,
// `Param<Contract, "typo">` 报出来的应当是 `'"id" | WholeContract'` 这样可行动的集合。
interface WholeContract {
  readonly [WHOLE]: true;
}

type SlotScalar = string | number | bigint | boolean | Date | null | undefined;

// 单键模式第二实参的上界:标量/字面量联合/标量数组(仅 Query 合法,槽位差异由编译器裁)。
type SlotValue = SlotScalar | readonly SlotScalar[];

type SingleKeyDefault<TShape> = undefined extends TShape ? string | undefined : string;

// [TShape] extends [string | undefined] 关闭分布式条件类型:可选单键 "x" | undefined
// 必须整体落进单键分支,否则 undefined 分量会漂进契约分支。
type StringSlot<
  TShape extends string | undefined | object,
  TSelect extends [TShape] extends [string | undefined] ? SlotValue : keyof TShape | WholeContract,
> = [TShape] extends [string | undefined]
  ? TSelect
  : [TSelect] extends [WholeContract]
    ? TShape
    : TSelect extends keyof TShape
      ? TShape[TSelect]
      : never;

export type Param<
  TShape extends string | undefined | object,
  TSelect extends [TShape] extends [string | undefined]
    ? SlotValue
    : keyof TShape | WholeContract = [TShape] extends [string | undefined]
    ? SingleKeyDefault<TShape>
    : WholeContract,
> = StringSlot<TShape, TSelect>;

export type Query<
  TShape extends string | undefined | object,
  TSelect extends [TShape] extends [string | undefined]
    ? SlotValue
    : keyof TShape | WholeContract = [TShape] extends [string | undefined]
    ? SingleKeyDefault<TShape>
    : WholeContract,
> = StringSlot<TShape, TSelect>;

export type Header<
  TShape extends string | undefined | object,
  TSelect extends [TShape] extends [string | undefined]
    ? SlotValue
    : keyof TShape | WholeContract = [TShape] extends [string | undefined]
    ? SingleKeyDefault<TShape>
    : WholeContract,
> = StringSlot<TShape, TSelect>;

export type Body<TContract, TSelect extends keyof TContract | WholeContract = WholeContract> = [
  TSelect,
] extends [WholeContract]
  ? TContract
  : TSelect extends keyof TContract
    ? TContract[TSelect]
    : never;
