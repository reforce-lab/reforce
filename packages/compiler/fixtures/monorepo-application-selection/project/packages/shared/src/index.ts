import { Injectable } from "@reforce/context";

export interface ExportPort {
  read(): string;
}

@Injectable()
export class HiddenSharedBean implements ExportPort {
  read(): string {
    return "hidden";
  }
}
