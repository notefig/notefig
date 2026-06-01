import { PROJECT_CONFIG_FILE_NAME } from "./project-config.constants";
import {
  getSchemaVersionFromUrl,
  isSupportedProjectConfigSchemaUrl,
  ProjectConfigV1Schema,
} from "./project-config.schema";
import type { ProjectConfigV1Output } from "./project-config.schema";
import {
  ProjectConfigJsonParseError,
  ProjectConfigSchemaReferenceError,
} from "./project-config.parse-errors";

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
