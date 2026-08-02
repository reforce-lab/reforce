import { Injectable, Qualifier } from "@reforce/context";

export interface ServicePort {}

@Injectable()
export class Service {
  constructor(@Qualifier("legacy") port: ServicePort) {
    void port;
  }
}
