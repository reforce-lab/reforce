import { classBean, factoryBean } from "@reforce/context/generated-runtime";
import type { GeneratedApplicationDefinition } from "@reforce/context/generated-runtime";
import { AlphaService as beanTarget0 } from "../../src/alpha.js";
import { ZetaService as beanTarget1 } from "../../src/zeta.js";

const registration0 = classBean({
  id: "src/alpha.ts#AlphaService",
  source: {
    "end": {
      "character": 1,
      "line": 14,
      "offset": 323
    },
    "file": "src/alpha.ts",
    "start": {
      "character": 7,
      "line": 8,
      "offset": 156
    }
  },
  target: beanTarget0,
  dependencies: [
    {
      "mode": "eager",
      "parameterIndex": 0,
      "source": {
        "end": {
          "character": 40,
          "line": 9,
          "offset": 259
        },
        "file": "src/alpha.ts",
        "start": {
          "character": 14,
          "line": 9,
          "offset": 233
        }
      },
      "targetId": "src/zeta.ts#ZetaService"
    }
  ],
  create: (resolver) => new beanTarget0(resolver.resolve(0)),
  hooks: {
    start: (bean) => bean.onContextStart(),
    close: (bean) => bean.onContextClose(),
  },
});

const registration1 = classBean({
  id: "src/zeta.ts#ZetaService",
  source: {
    "end": {
      "character": 1,
      "line": 14,
      "offset": 326
    },
    "file": "src/zeta.ts",
    "start": {
      "character": 7,
      "line": 8,
      "offset": 158
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
          "line": 9,
          "offset": 262
        },
        "file": "src/zeta.ts",
        "start": {
          "character": 14,
          "line": 9,
          "offset": 234
        }
      },
      "targetId": "src/alpha.ts#AlphaService"
    }
  ],
  create: (resolver) => new beanTarget1(resolver.resolve(0)),
  hooks: {
    start: (bean) => bean.onContextStart(),
    close: (bean) => bean.onContextClose(),
  },
});

export const applicationDefinition = {
  schemaVersion: 1,
  registrations: [registration0, registration1],
  plans: {
    "cleanupActionOrder": [
      "src/zeta.ts#ZetaService",
      "src/alpha.ts#AlphaService"
    ],
    "constructionOrder": [
      "src/zeta.ts#ZetaService",
      "src/alpha.ts#AlphaService"
    ],
    "startActionOrder": [
      "src/alpha.ts#AlphaService",
      "src/zeta.ts#ZetaService"
    ]
  },
} as const satisfies GeneratedApplicationDefinition;
