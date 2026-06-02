import { PROJECT_CONFIG_FILE_NAME } from "./project-config.constants";
import {
  getSchemaVersionFromUrl,
  isSupportedProjectConfigSchemaUrl,
  ProjectConfigV1Schema,
} from "./project-config.schema";
import type { ProjectConfigV1Output } from "./project-config.schema";
import {
  ProjectConfigJsonParseError,
  ProjectConfigEnvResolutionError,
  ProjectConfigSchemaReferenceError,
} from "./project-config.parse-errors";

type EnvInput = Record<string, string | undefined>;

const ENV_REF_PATTERN = /^\$([A-Z_][A-Z0-9_]*)$/;

function resolveEnvReference(value: string, env: EnvInput): string {
  const match = ENV_REF_PATTERN.exec(value);
  if (!match) return value;

  const envName = match[1];
  const resolved = env[envName];
  if (resolved !== undefined) return resolved;

  throw new ProjectConfigEnvResolutionError(
    `Missing environment variable "${envName}" for ${PROJECT_CONFIG_FILE_NAME}`,
  );
}

function deepMapStrings(
  value: unknown,
  map: (text: string) => string,
): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value))
    return value.map((item) => deepMapStrings(item, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        deepMapStrings(child, map),
      ]),
    );
  }
  return value;
}

export function parseProjectConfig(rawContent: string): ProjectConfigV1Output {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new ProjectConfigJsonParseError(error);
  }

  return parseProjectConfigObject(parsed);
}

export function parseProjectConfigObject(raw: unknown): ProjectConfigV1Output {
  if (!raw || typeof raw !== "object") {
    throw new ProjectConfigSchemaReferenceError(
      `Invalid ${PROJECT_CONFIG_FILE_NAME}: expected a JSON object`,
    );
  }

  const schemaUrl = (raw as Record<string, unknown>).$schema;
  if (schemaUrl === undefined) {
    throw new ProjectConfigSchemaReferenceError(
      `Invalid ${PROJECT_CONFIG_FILE_NAME}: required field "$schema" is missing`,
    );
  }

  if (typeof schemaUrl !== "string") {
    throw new ProjectConfigSchemaReferenceError(
      `Invalid ${PROJECT_CONFIG_FILE_NAME}: "$schema" must be a string URL`,
    );
  }

  if (!isSupportedProjectConfigSchemaUrl(schemaUrl)) {
    const parsedVersion = getSchemaVersionFromUrl(schemaUrl);
    const versionLabel =
      parsedVersion === null ? schemaUrl : `v${parsedVersion}`;
    throw new ProjectConfigSchemaReferenceError(
      `Unsupported ${PROJECT_CONFIG_FILE_NAME} schema version "${versionLabel}".`,
    );
  }

  return ProjectConfigV1Schema.parse(raw);
}

export function parseProjectConfigWithEnv(
  rawContent: string,
  env: EnvInput,
): ProjectConfigV1Output {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new ProjectConfigJsonParseError(error);
  }

  return parseProjectConfigObjectWithEnv(parsed, env);
}

export function parseProjectConfigObjectWithEnv(
  raw: unknown,
  env: EnvInput,
): ProjectConfigV1Output {
  const resolved = deepMapStrings(raw, (text) =>
    resolveEnvReference(text, env),
  );
  return parseProjectConfigObject(resolved);
}
