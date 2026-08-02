import type { ReadResolvedTarget } from "@/resolution-state";

export function createCycleProxy(readTarget: ReadResolvedTarget): object {
  const target: object = Object.create(null);
  return new Proxy(target, {
    defineProperty: (_target, property, attributes) =>
      Reflect.defineProperty(readTarget(), property, attributes),
    deleteProperty: (_target, property) => Reflect.deleteProperty(readTarget(), property),
    get: (_target, property, receiver) => Reflect.get(readTarget(), property, receiver),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(readTarget(), property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(readTarget()),
    has: (_target, property) => Reflect.has(readTarget(), property),
    isExtensible: () => {
      readTarget();
      return true;
    },
    ownKeys: () => Reflect.ownKeys(readTarget()),
    preventExtensions: () => {
      readTarget();
      return false;
    },
    set: (_target, property, value, receiver) =>
      Reflect.set(readTarget(), property, value, receiver),
    setPrototypeOf: (_target, prototype) => Reflect.setPrototypeOf(readTarget(), prototype),
  });
}
