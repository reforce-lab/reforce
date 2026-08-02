import { defineBean } from "@reforce/context";

export class Resource {}

function cleanup(resource: Resource): void {
  void resource;
}

export const resource = defineBean<Resource>({
  create: () => new Resource(),
  dispose: cleanup,
});
