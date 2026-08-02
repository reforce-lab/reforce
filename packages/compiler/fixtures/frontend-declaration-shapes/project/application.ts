import type { PaymentPort as Port } from "./ports";
import { defineBean, Injectable, Primary, Qualifier } from "@reforce/context";

export interface Repository<T> extends Port, AsyncIterable<T> {}

export namespace Tokens {
  export interface Payment {}
  export const label = "payment";
}

@Qualifier("primary")
@Primary()
@Injectable()
export class PaymentService<T> implements Repository<T> {
  public constructor(repository: Repository<T>, retries: number = 3) {}

  public async onStart(): Promise<void> {}

  public async onClose(): Promise<void> {}
}

export const paymentGateway = defineBean<PaymentService<string>>({
  create: () => new PaymentService(repository),
  dispose: async (gateway: PaymentService<string>) => gateway.onClose(),
  primary: true,
  qualifier: "gateway",
});
