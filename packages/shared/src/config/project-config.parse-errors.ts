import { PROJECT_CONFIG_FILE_NAME } from "./project-config.constants";

export class ProjectConfigJsonParseError extends Error {
  constructor(cause?: unknown) {
    super(`Invalid ${PROJECT_CONFIG_FILE_NAME}: file is not valid JSON`);
    this.name = "ProjectConfigJsonParseError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class ProjectConfigSchemaReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigSchemaReferenceError";
  }
}
