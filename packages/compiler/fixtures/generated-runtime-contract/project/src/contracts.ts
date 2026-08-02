export interface AlphaPort {
  alpha(): string;
}

export interface BetaPort {
  beta(): string;
}

export class ManagedResource {
  close(): void {}
}
