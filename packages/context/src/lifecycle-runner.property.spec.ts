import { expect, test } from "bun:test";
import fc from "fast-check";
import { testDefinition, testSource } from "../test-support/test-definition";
import { classBean, createApplicationContext } from "./generated-runtime";
import { ApplicationStartError } from "./index";

test("every successfully created resource is cleaned once after a construction failure", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (failureIndex) => {
      const cleanupCounts = Array.from({ length: 6 }, () => 0);
      const registrations = cleanupCounts.map((_, index) => {
        const Resource = class {
          readonly index = index;
        };
        return classBean({
          id: `src/resource-${index}.ts#Resource${index}`,
          source: testSource(`resource-${index}`),
          target: Resource,
          dependencies: [],
          create: () => {
            if (index === failureIndex) {
              throw new Error(`failure ${index}`);
            }
            return new Resource();
          },
          hooks: {
            close: () => {
              cleanupCounts[index] = (cleanupCounts[index] ?? 0) + 1;
            },
          },
        });
      });
      const context = createApplicationContext(
        testDefinition(registrations, {
          cleanupActionOrder: registrations.map((item) => item.id).reverse(),
        }),
      );

      const error = await context.start().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ApplicationStartError);
      expect(cleanupCounts).toEqual(
        cleanupCounts.map((_, index) => (index < failureIndex ? 1 : 0)),
      );
    }),
    { numRuns: 40 },
  );
});

test("registration input order does not replace the generated lifecycle order", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 0, max: 3 }), {
        minLength: 4,
        maxLength: 4,
      }),
      async (inputOrder) => {
        const actions: number[] = [];
        const registrations = Array.from({ length: 4 }, (_, index) => {
          const Resource = class {};
          return classBean({
            id: `src/resource-${index}.ts#Resource${index}`,
            source: testSource(`resource-${index}`),
            target: Resource,
            dependencies: [],
            create: () => new Resource(),
            hooks: {
              start: () => {
                actions.push(index);
              },
            },
          });
        });
        const shuffled = inputOrder.map((index) => {
          const registration = registrations[index];
          if (!registration) {
            throw new Error(`Missing generated registration ${index}.`);
          }
          return registration;
        });
        const plan = registrations.map((registration) => registration.id);
        const context = createApplicationContext(
          testDefinition(shuffled, {
            constructionOrder: plan,
            startActionOrder: plan,
          }),
        );

        await context.start();

        expect(actions).toEqual([0, 1, 2, 3]);
        await context.close();
      },
    ),
    { numRuns: 40 },
  );
});
