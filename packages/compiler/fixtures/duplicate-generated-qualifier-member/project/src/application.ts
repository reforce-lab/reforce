import { Injectable } from "@reforce/context";

export interface PaymentPort {}

export namespace PaymentPort {
  export interface PaymentService {}
}

@Injectable()
export class PaymentService implements PaymentPort {}
