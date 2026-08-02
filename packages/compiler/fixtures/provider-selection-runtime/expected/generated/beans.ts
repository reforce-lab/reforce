import { classBean, factoryBean } from "@reforce/context/generated-runtime";
import type { GeneratedApplicationDefinition } from "@reforce/context/generated-runtime";
import { FallbackProvider as beanTarget0 } from "../../src/application.js";
import { PreferredProvider as beanTarget1 } from "../../src/application.js";
import { SelectionProbe as beanTarget2 } from "../../src/application.js";
import { UniqueProvider as beanTarget3 } from "../../src/application.js";

const registration0 = classBean({
  id: "src/application.ts#FallbackProvider",
  source: {
    "end": {
      "character": 1,
      "line": 12,
      "offset": 261
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 8,
      "offset": 165
    }
  },
  target: beanTarget0,
  dependencies: [
  ],
  create: (resolver) => new beanTarget0(),
  hooks: {},
});

const registration1 = classBean({
  id: "src/application.ts#PreferredProvider",
  source: {
    "end": {
      "character": 1,
      "line": 21,
      "offset": 417
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 17,
      "offset": 319
    }
  },
  target: beanTarget1,
  dependencies: [
  ],
  create: (resolver) => new beanTarget1(),
  hooks: {},
});

const registration2 = classBean({
  id: "src/application.ts#SelectionProbe",
  source: {
    "end": {
      "character": 1,
      "line": 45,
      "offset": 907
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 35,
      "offset": 606
    }
  },
  target: beanTarget2,
  dependencies: [
    {
      "mode": "eager",
      "parameterIndex": 0,
      "source": {
        "end": {
          "character": 37,
          "line": 37,
          "offset": 681
        },
        "file": "src/application.ts",
        "start": {
          "character": 4,
          "line": 37,
          "offset": 648
        }
      },
      "targetId": "src/application.ts#PreferredProvider"
    },
    {
      "mode": "eager",
      "parameterIndex": 1,
      "source": {
        "end": {
          "character": 48,
          "line": 38,
          "offset": 731
        },
        "file": "src/application.ts",
        "start": {
          "character": 4,
          "line": 38,
          "offset": 687
        }
      },
      "targetId": "src/application.ts#FallbackProvider"
    },
    {
      "mode": "eager",
      "parameterIndex": 2,
      "source": {
        "end": {
          "character": 35,
          "line": 39,
          "offset": 768
        },
        "file": "src/application.ts",
        "start": {
          "character": 4,
          "line": 39,
          "offset": 737
        }
      },
      "targetId": "src/application.ts#UniqueProvider"
    }
  ],
  create: (resolver) => new beanTarget2(resolver.resolve(0), resolver.resolve(1), resolver.resolve(2)),
  hooks: {},
});

const registration3 = classBean({
  id: "src/application.ts#UniqueProvider",
  source: {
    "end": {
      "character": 1,
      "line": 32,
      "offset": 583
    },
    "file": "src/application.ts",
    "start": {
      "character": 7,
      "line": 28,
      "offset": 492
    }
  },
  target: beanTarget3,
  dependencies: [
  ],
  create: (resolver) => new beanTarget3(),
  hooks: {},
});

export const applicationDefinition = {
  schemaVersion: 1,
  registrations: [registration0, registration1, registration2, registration3],
  plans: {
    "cleanupActionOrder": [
    ],
    "constructionOrder": [
      "src/application.ts#FallbackProvider",
      "src/application.ts#PreferredProvider",
      "src/application.ts#UniqueProvider",
      "src/application.ts#SelectionProbe"
    ],
    "startActionOrder": [
    ]
  },
} as const satisfies GeneratedApplicationDefinition;
