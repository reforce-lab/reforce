import { classBean, factoryBean } from "@reforce/context/generated-runtime";
import type { GeneratedApplicationDefinition } from "@reforce/context/generated-runtime";
import { Consumer as beanTarget0 } from "../../src/application.js";
import { Provider as beanTarget1 } from "../../src/application.js";

const registration0 = classBean({
  id: "src/application.ts#Consumer",
  source: {
    "end": {
      "character": 1,
      "line": 9,
      "offset": 227
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 7,
      "offset": 165
    }
  },
  target: beanTarget0,
  dependencies: [
    {
      "mode": "eager",
      "parameterIndex": 0,
      "source": {
        "end": {
          "character": 39,
          "line": 8,
          "offset": 221
        },
        "file": "src/application.ts",
        "start": {
          "character": 14,
          "line": 8,
          "offset": 196
        }
      },
      "targetId": "src/application.ts#Provider"
    }
  ],
  create: (resolver) => new beanTarget0(resolver.resolve(0)),
  hooks: {},
});

const registration1 = classBean({
  id: "src/application.ts#Provider",
  source: {
    "end": {
      "character": 46,
      "line": 4,
      "offset": 142
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 4,
      "offset": 103
    }
  },
  target: beanTarget1,
  dependencies: [
  ],
  create: (resolver) => new beanTarget1(),
  hooks: {},
});

export const applicationDefinition = {
  schemaVersion: 1,
  registrations: [registration0, registration1],
  plans: {
    "cleanupActionOrder": [
    ],
    "constructionOrder": [
      "src/application.ts#Provider",
      "src/application.ts#Consumer"
    ],
    "startActionOrder": [
    ]
  },
} as const satisfies GeneratedApplicationDefinition;
