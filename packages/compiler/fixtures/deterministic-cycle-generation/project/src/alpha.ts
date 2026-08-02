import {
  Injectable,
  type OnContextClose,
  type OnContextStart,
} from "@reforce/context";
import { ZetaService } from "./zeta";

@Injectable()
export class AlphaService implements OnContextStart, OnContextClose {
  constructor(readonly zeta: ZetaService) {}

  onContextStart(): void {}

  onContextClose(): void {}
}
