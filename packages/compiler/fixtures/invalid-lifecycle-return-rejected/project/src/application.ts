import { Injectable, type OnContextStart } from "@reforce/context";

@Injectable()
export class Service implements OnContextStart {
  onContextStart(): string {
    return "invalid";
  }
}
