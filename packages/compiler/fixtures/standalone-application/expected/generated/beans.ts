import { classBean, factoryBean } from "@reforce/context/generated-runtime";
import type { GeneratedApplicationDefinition } from "@reforce/context/generated-runtime";
import { GreetingService as beanTarget0 } from "../../src/application.js";
import { MessageRepository as beanTarget1 } from "../../src/application.js";

const registration0 = classBean({
  id: "src/application.ts#GreetingService",
  source: {
    "end": {
      "character": 1,
      "line": 38,
      "offset": 729
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 18,
      "offset": 290
    }
  },
  target: beanTarget0,
  dependencies: [
    {
      "mode": "eager",
      "parameterIndex": 0,
      "source": {
        "end": {
          "character": 38,
          "line": 23,
          "offset": 475
        },
        "file": "src/application.ts",
        "start": {
          "character": 14,
          "line": 23,
          "offset": 451
        }
      },
      "targetId": "src/application.ts#MessageRepository"
    }
  ],
  create: (resolver) => new beanTarget0(resolver.resolve(0)),
  hooks: {
    start: (bean) => bean.onContextStart(),
    close: (bean) => bean.onContextClose(),
  },
});

const registration1 = classBean({
  id: "src/application.ts#MessageRepository",
  source: {
    "end": {
      "character": 1,
      "line": 15,
      "offset": 267
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 11,
      "offset": 172
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
      "src/application.ts#GreetingService"
    ],
    "constructionOrder": [
      "src/application.ts#MessageRepository",
      "src/application.ts#GreetingService"
    ],
    "startActionOrder": [
      "src/application.ts#GreetingService"
    ]
  },
} as const satisfies GeneratedApplicationDefinition;
