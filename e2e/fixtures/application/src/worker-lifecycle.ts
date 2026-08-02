import {
  defineBean,
  Injectable,
  type Lazy,
  type OnContextClose,
  type OnContextStart,
} from "@reforce/context";

let alphaCreations = 0;
let lifecycleStarts = 0;
let lifecycleCloses = 0;
let resourceCreations = 0;
let resourceDisposals = 0;

export class ManagedResource {
  constructor(readonly marker: number) {}
}

@Injectable()
export class AlphaService implements OnContextStart, OnContextClose {
  readonly marker = ++alphaCreations;

  constructor(
    readonly beta: BetaService,
    readonly resource: Lazy<ManagedResource>,
  ) {}

  onContextStart(): void {
    lifecycleStarts += 1;
  }

  onContextClose(): void {
    lifecycleCloses += 1;
  }
}

@Injectable()
export class BetaService {
  constructor(readonly alpha: AlphaService) {}
}

export const managedResource = defineBean<ManagedResource>({
  create: () => new ManagedResource(++resourceCreations),
  dispose: (_resource) => {
    resourceDisposals += 1;
  },
});

export function lifecycleSnapshot() {
  return {
    starts: lifecycleStarts,
    closes: lifecycleCloses,
    resourceCreations,
    resourceDisposals,
  };
}
