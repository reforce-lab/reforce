import type { ImportPort } from "#shared-contract";
import { Injectable } from "@reforce/context";
import type { ExportPort } from "@fixture/shared";
import type { PathPort } from "@shared/path";

@Injectable()
export class ExportAdapter implements ExportPort {
  read(): string {
    return "export";
  }
}

@Injectable()
export class PathAdapter implements PathPort {
  path(): string {
    return "path";
  }
}

@Injectable()
export class ImportAdapter implements ImportPort {
  imported(): string {
    return "imports";
  }
}

@Injectable()
export class ApiService {
  constructor(
    readonly exported: ExportPort,
    readonly pathed: PathPort,
    readonly imported: ImportPort,
  ) {}
}
