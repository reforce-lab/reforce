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
      // The proxy target is a dummy null-prototype object that never holds the real
      // bean's properties, so a non-configurable descriptor reported here would
      // violate Proxy invariants and throw a TypeError; configurable is forced.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(readTarget()),
    has: (_target, property) => Reflect.has(readTarget(), property),
    isExtensible: () => {
      readTarget();
      // Must match the dummy target, which stays extensible; reporting the real
      // bean's extensibility would break Proxy invariants.
      return true;
    },
    ownKeys: () => Reflect.ownKeys(readTarget()),
    preventExtensions: () => {
      readTarget();
      // The dummy target must stay extensible (see isExtensible), so freezing
      // through the proxy is rejected by reporting failure.
      return false;
    },
    set: (_target, property, value, receiver) =>
      Reflect.set(readTarget(), property, value, receiver),
    setPrototypeOf: (_target, prototype) => Reflect.setPrototypeOf(readTarget(), prototype),
  });
}
