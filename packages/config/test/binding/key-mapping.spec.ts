import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  buildBindingInput,
  camelJoin,
  environmentVariableName,
  expandKeyPaths,
  splitWords,
  suggestEnvironmentName,
} from "@/binding/key-mapping";

describe("splitWords", () => {
  test("splits camelCase names on the ADR 0005 boundary algorithm", () => {
    // ADR 0005 要求把边界算法（含连续大写）用表锁死
    const rows: readonly (readonly [string, readonly string[]])[] = [
      ["maxRetries", ["max", "retries"]],
      ["httpURL", ["http", "url"]],
      ["URLValue", ["url", "value"]],
      ["s3Bucket", ["s3", "bucket"]],
      ["retry2Max", ["retry2", "max"]],
      ["HTTP2Server", ["http", "2", "server"]],
      ["port", ["port"]],
    ];

    for (const [name, words] of rows) {
      expect(splitWords(name)).toEqual(words);
    }
  });
});

describe("camelJoin", () => {
  test("joins lowercase words into one camelCase name", () => {
    expect(camelJoin(["http", "port"])).toBe("httpPort");
    expect(camelJoin(["port"])).toBe("port");
    expect(camelJoin(["retry", "2"])).toBe("retry2");
  });
});

describe("environmentVariableName", () => {
  test("maps prefix and nested path segments to one underscore name", () => {
    expect(environmentVariableName("server", ["http", "port"])).toBe("SERVER_HTTP_PORT");
    expect(environmentVariableName("app.mainDb", ["hosts", 0, "name"])).toBe(
      "APP_MAIN_DB_HOSTS_0_NAME",
    );
  });

  test("maps camelCase field names to the same name as the nested shape", () => {
    // 正向映射只看词序、不看嵌套形状——这正是反向展开必须盲展的原因
    expect(environmentVariableName("server", ["httpPort"])).toBe("SERVER_HTTP_PORT");
  });
});

describe("expandKeyPaths", () => {
  test("returns every boundary assignment with all-join first", () => {
    expect(expandKeyPaths(["http", "port"])).toEqual([["httpPort"], ["http", "port"]]);
  });

  test("returns four candidates for three segments", () => {
    expect(expandKeyPaths(["a", "b", "c"])).toEqual([
      ["aBC"],
      ["a", "bC"],
      ["aB", "c"],
      ["a", "b", "c"],
    ]);
  });

  test("returns only the two extremes beyond twelve segments", () => {
    const segments = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "sa", "sb", "sc"];

    const paths = expandKeyPaths(segments);

    expect(paths).toEqual([[camelJoin(segments)], segments]);
  });
});

describe("buildBindingInput", () => {
  test("merges every candidate shape of a single key", () => {
    const entries = new Map([["SERVER_HTTP_PORT", "1"]]);

    const input = buildBindingInput(["server"], entries);

    expect(input).toEqual({ httpPort: "1", http: { port: "1" } });
  });

  test("replaces an existing scalar when a later candidate needs an object", () => {
    const entries = new Map([
      ["SERVER_A", "x"],
      ["SERVER_A_B", "y"],
    ]);

    const input = buildBindingInput(["server"], entries);

    expect(input).toEqual({ a: { b: "y" }, aB: "y" });
  });

  test("never overwrites an existing object with a scalar", () => {
    // SERVER_RETRY2_MAX 按 UTF-16 排序先处理并把 retry2 变成对象；
    // SERVER_RETRY_2 的全并候选 ["retry2"] 随后到达，标量不得踩掉对象
    const entries = new Map([
      ["SERVER_RETRY_2", "7"],
      ["SERVER_RETRY2_MAX", "5"],
    ]);

    const input = buildBindingInput(["server"], entries);

    expect(input).toEqual({
      retry2: { max: "5" },
      retry2Max: "5",
      retry: { "2": "7" },
    });
  });

  test("ignores keys outside the prefix segment", () => {
    const entries = new Map([
      ["SERVERX_PORT", "1"],
      ["OTHER_PORT", "2"],
      ["SERVER", "3"],
    ]);

    const input = buildBindingInput(["server"], entries);

    expect(input).toEqual({});
  });

  test("round-trips any forward-mapped field path back to its value", () => {
    const word = fc.constantFrom("port", "http", "max", "retries", "cache", "url");
    const fieldName = fc
      .array(word, { minLength: 1, maxLength: 2 })
      .map((words) => camelJoin(words));
    const fieldPath = fc.array(fieldName, { minLength: 1, maxLength: 3 });

    fc.assert(
      fc.property(fieldPath, (path) => {
        const name = environmentVariableName("server", path);
        const input = buildBindingInput(["server"], new Map([[name, "value"]]));

        let node: unknown = input;
        for (const segment of path) {
          expect(typeof node === "object" && node !== null && segment in node).toBe(true);
          node = Reflect.get(Object(node), segment);
        }
        expect(node).toBe("value");
      }),
    );
  });
});

describe("suggestEnvironmentName", () => {
  test("suggests the nearest known name within distance three", () => {
    const suggestion = suggestEnvironmentName("SERVER_HTTP_PROT", [
      "SERVER_HTTP_PORT",
      "SERVER_TIMEOUT",
    ]);

    expect(suggestion).toBe("SERVER_HTTP_PORT");
  });

  test("suggests nothing when every known name is farther than three", () => {
    expect(suggestEnvironmentName("SERVER_ZZZZZZ", ["SERVER_HTTP_PORT"])).toBeUndefined();
  });

  test("breaks ties by UTF-16 order", () => {
    expect(suggestEnvironmentName("SERVER_AX", ["SERVER_AZ", "SERVER_AY"])).toBe("SERVER_AY");
  });
});
