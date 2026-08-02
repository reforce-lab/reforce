import { Injectable, Primary, Qualifier } from "@reforce/context";

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
