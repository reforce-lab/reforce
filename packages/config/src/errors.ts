import { defineError } from "@reforce/core/define-error";

// 本包的四处失败此前全是裸 TypeError（ADR 0013 决议 3，#292）：无码、无 help、不进
// isReforceError 识别。base 维持 TypeError——现状就是它，语义也对（调用方给错了东西）。
//
// 绑定失败本身不在这里：那是 @reforce/core 的 ConfigBindingError（CONFIG_BINDING_FAILED），
// 它报的是「环境里的值不满足 schema」这类用户运维问题，而这四个报的是编程错误。

export const InvalidPropertiesPrefixError = defineError<
  "CONFIG_INVALID_PROPERTIES_PREFIX",
  [received: string]
>(
  "CONFIG_INVALID_PROPERTIES_PREFIX",
  "ConfigProperties prefix must be dot-separated camelCase words (received %s).",
  {
    base: TypeError,
    help: "The prefix is what maps a class to environment keys: `server.http` reads SERVER_HTTP_*. Write it in camelCase words joined by dots, with no leading or trailing dot.",
  },
);

export const InvalidPropertiesSchemaError = defineError<"CONFIG_INVALID_PROPERTIES_SCHEMA">(
  "CONFIG_INVALID_PROPERTIES_SCHEMA",
  "ConfigProperties schema must implement Standard Schema v1 (an object with a `~standard` property carrying `version: 1` and a `validate` function).",
  {
    base: TypeError,
    help: "Any Standard Schema v1 library works (Zod, Valibot, ArkType and others). Pass the schema object itself, not a factory that returns one.",
  },
);

export const MissingPropertiesBaseError = defineError<
  "CONFIG_MISSING_PROPERTIES_BASE",
  [configId: string]
>(
  "CONFIG_MISSING_PROPERTIES_BASE",
  'Config "%s" does not extend a ConfigProperties(...) base class.',
  {
    base: TypeError,
    help: "The compiler only registers classes that extend ConfigProperties(prefix, schema), so reaching this means the generated artifact no longer matches the sources. Rebuild the project.",
  },
);

export const InvalidSchemaOutputError = defineError<
  "CONFIG_INVALID_SCHEMA_OUTPUT",
  [configId: string]
>("CONFIG_INVALID_SCHEMA_OUTPUT", 'Config "%s" schema produced a non-object output.', {
  base: TypeError,
  help: "Binding copies the validated output onto the config instance, so the schema has to describe an object. A schema that transforms into a primitive or an array cannot back a config class.",
});
