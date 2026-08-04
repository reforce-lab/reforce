import { writeFileSync } from "node:fs";
import { Injectable, type OnContextStart, Order, Primary, Qualifier } from "@reforce/context";

export interface DefaultPort {
  value(): string;
}

@Injectable()
@Qualifier("Fallback")
export class FallbackProvider implements DefaultPort {
  value(): string {
    return "fallback";
  }
}

@Injectable()
@Primary()
@Qualifier("Preferred")
@Order(1)
export class PreferredProvider implements DefaultPort {
  value(): string {
    return "preferred";
  }
}

export interface UniquePort {
  value(): string;
}

@Injectable()
export class UniqueProvider implements UniquePort {
  value(): string {
    return "unique";
  }
}

@Injectable()
export class SelectionProbe {
  constructor(
    readonly defaultPort: DefaultPort,
    readonly uniquePort: UniquePort,
  ) {}

  values(): readonly string[] {
    return [this.defaultPort.value(), this.uniquePort.value()];
  }
}

// 集合注入场景（ADR 0006 W6，#150）：readonly DefaultPort[] 收进全部实现；@Order(1) 的
// PreferredProvider 排在无 @Order 的 FallbackProvider（beanId 序）之前。
@Injectable()
export class PortCollector implements OnContextStart {
  constructor(readonly ports: readonly DefaultPort[]) {}

  onContextStart(): void {
    const path = process.env.REFORCE_E2E_COLLECTION_OUT;
    if (path !== undefined) {
      writeFileSync(path, `${this.ports.map((port) => port.value()).join(",")}\n`, "utf8");
    }
  }
}
