import { expect, test } from "bun:test";
import fc from "fast-check";
import { classBean, createApplicationContext } from "#internal/generated-runtime";
import { testDefinition, testSource } from "#test-support/test-definition";

test("concurrent shutdown callers share one result and one cleanup", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 32 }), async (callCount) => {
      class Resource {}
      let cleanups = 0;
      const registration = classBean({
        id: "src/resource.ts#Resource",
        source: testSource("resource"),
        target: Resource,
        dependencies: [],
        create: () => new Resource(),
        hooks: {
          close: async () => {
            await Promise.resolve();
            cleanups += 1;
          },
        },
      });
      const context = createApplicationContext(testDefinition([registration]));
      await context.start();

      const promises = Array.from({ length: callCount }, () => context.close());

      expect(new Set(promises).size).toBe(1);
      await Promise.all(promises);
      expect(cleanups).toBe(1);
    }),
    { numRuns: 40 },
  );
});
