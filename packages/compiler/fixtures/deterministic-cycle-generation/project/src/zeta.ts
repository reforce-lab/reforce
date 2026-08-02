import {
  Injectable,
  type OnContextClose,
  type OnContextStart,
} from "@reforce/context";
import { AlphaService } from "./alpha";

@Injectable()
export class ZetaService implements OnContextStart, OnContextClose {
  constructor(readonly alpha: AlphaService) {}

  onContextStart(): void {}

  onContextClose(): void {}
}
