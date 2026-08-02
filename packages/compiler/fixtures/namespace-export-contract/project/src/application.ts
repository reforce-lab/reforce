import { Injectable } from "@reforce/context";
import { Ports } from "./barrel";

@Injectable()
export class Provider implements Ports.Port {}

@Injectable()
export class Consumer {
  constructor(readonly port: Ports.Port) {}
}
