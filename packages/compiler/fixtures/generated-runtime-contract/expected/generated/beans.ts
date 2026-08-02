import { classBean, factoryBean } from "@reforce/context/generated-runtime";
import type { GeneratedApplicationDefinition } from "@reforce/context/generated-runtime";
import { AlphaService as beanTarget0 } from "../../src/application.js";
import { BetaService as beanTarget1 } from "../../src/application.js";
import { managedResource as beanTarget2 } from "../../src/application.js";

const registration0 = classBean({
  id: "src/application.ts#AlphaService",
  source: {
    "end": {
      "character": 1,
      "line": 23,
      "offset": 510
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 10,
      "offset": 223
    }
  },
  target: beanTarget0,
  dependencies: [
    {
      "mode": "eager",
      "parameterIndex": 0,
      "source": {
        "end": {
          "character": 30,
          "line": 12,
          "offset": 342
        },
        "file": "src/application.ts",
        "start": {
          "character": 4,
          "line": 12,
          "offset": 316
        }
      },
      "targetId": "src/application.ts#BetaService"
    },
    {
      "mode": "explicit-lazy",
      "parameterIndex": 1,
      "source": {
        "end": {
          "character": 44,
          "line": 13,
          "offset": 388
        },
        "file": "src/application.ts",
        "start": {
          "character": 4,
          "line": 13,
          "offset": 348
        }
      },
      "targetId": "src/application.ts#managedResource"
    }
  ],
  create: (resolver) => new beanTarget0(resolver.resolve(0), resolver.lazy(1)),
  hooks: {
    start: (bean) => bean.onContextStart(),
    close: (bean) => bean.onContextClose(),
  },
});

const registration1 = classBean({
  id: "src/application.ts#BetaService",
  source: {
    "end": {
      "character": 1,
      "line": 32,
      "offset": 664
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 26,
      "offset": 533
    }
  },
  target: beanTarget1,
  dependencies: [
    {
      "mode": "cycle-proxy",
      "parameterIndex": 0,
      "source": {
        "end": {
          "character": 42,
          "line": 27,
          "offset": 615
        },
        "file": "src/application.ts",
        "start": {
          "character": 14,
          "line": 27,
          "offset": 587
        }
      },
      "targetId": "src/application.ts#AlphaService"
    }
  ],
  create: (resolver) => new beanTarget1(resolver.resolve(0)),
  hooks: {},
});

const registration2 = factoryBean({
  id: "src/application.ts#managedResource",
  source: {
    "end": {
      "character": 2,
      "line": 37,
      "offset": 811
    },
    "file": "src/application.ts",
    "start": {
      "character": 13,
      "line": 34,
      "offset": 679
    }
  },
  definition: beanTarget2,
});

export const applicationDefinition = {
  schemaVersion: 1,
  registrations: [registration0, registration1, registration2],
  plans: {
    "cleanupActionOrder": [
      "src/application.ts#AlphaService",
      "src/application.ts#managedResource"
    ],
    "constructionOrder": [
      "src/application.ts#BetaService",
      "src/application.ts#AlphaService",
      "src/application.ts#managedResource"
    ],
    "startActionOrder": [
      "src/application.ts#AlphaService"
    ]
  },
} as const satisfies GeneratedApplicationDefinition;
