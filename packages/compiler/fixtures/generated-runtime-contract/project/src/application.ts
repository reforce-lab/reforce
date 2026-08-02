import {
  defineBean,
  Injectable,
  type Lazy,
  type OnContextClose,
  type OnContextStart,
} from "@reforce/context";
import { type AlphaPort, type BetaPort, ManagedResource } from "./contracts";

@Injectable()
export class AlphaService implements AlphaPort, OnContextStart, OnContextClose {
  constructor(
    readonly beta: BetaService,
    readonly resource: Lazy<ManagedResource>,
  ) {}

  alpha(): string {
    return this.beta.beta();
  }

  onContextStart(): void {}

  onContextClose(): void {}
}

@Injectable()
export class BetaService implements BetaPort {
  constructor(readonly alpha: AlphaService) {}

  beta(): string {
    return "beta";
  }
}

export const managedResource = defineBean<ManagedResource>({
  create: () => new ManagedResource(),
  dispose: (resource) => resource.close(),
});
