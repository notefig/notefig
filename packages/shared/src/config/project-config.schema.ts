import { z } from "zod";
import {
  PROJECT_CONFIG_SCHEMA_URL_V1,
  PROJECT_CONFIG_SUPPORTED_SCHEMA_URLS,
} from "./project-config.constants";

const SecretValueSchema = z
  .string()
  .regex(/^\$[A-Z_][A-Z0-9_]*$/, "Must be an env ref like $ENV_VAR")
  .or(z.string().min(1));

const WebDeployProviderSchema = z.enum([
  "netlify",
  "vercel",
  "nixpacks",
  "coolify",
  "railway",
  "s3",
]);

export const ProjectConfigV1Schema = z
  .object({
    $schema: z.literal(PROJECT_CONFIG_SCHEMA_URL_V1),
    editing: z
      .object({
        textDirection: z.enum(["ltr", "rtl"]),
      })
      .strict(),
    lifecycle: z
      .object({
        git: z
          .object({
            enabled: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    outputs: z
      .object({
        web: z
          .object({
            enabled: z.boolean(),
            outDir: z.string().min(1),
            theme: z.string().min(1),
            deploy: z
              .object({
                provider: WebDeployProviderSchema.nullable(),
                options: z.record(z.string(), z.unknown()),
              })
              .strict(),
          })
          .strict(),
        epub: z
          .object({
            enabled: z.boolean(),
            coverImagePath: z.string().min(1),
          })
          .strict(),
        pdf: z
          .object({
            enabled: z.boolean(),
          })
          .strict(),
        audiobook: z
          .object({
            enabled: z.boolean(),
            provider: z.literal("elevenlabs"),
            apiKey: SecretValueSchema,
            voiceId: SecretValueSchema,
            modelId: z.string().min(1),
            format: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const enabledCount = [
      value.outputs.web.enabled,
      value.outputs.epub.enabled,
      value.outputs.pdf.enabled,
      value.outputs.audiobook.enabled,
    ].filter(Boolean).length;

    if (enabledCount === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["outputs"],
        message: "At least one output artifact must be enabled",
      });
    }
  });

export type ProjectConfigV1Input = z.input<typeof ProjectConfigV1Schema>;
export type ProjectConfigV1Output = z.output<typeof ProjectConfigV1Schema>;

type ZodWithJsonSchema = typeof z & {
  toJSONSchema?: (
    schema: unknown,
    params?: {
      name?: string;
    },
  ) => unknown;
};

export function getProjectConfigV1JsonSchema() {
  const zodWithJsonSchema = z as ZodWithJsonSchema;
  if (!zodWithJsonSchema.toJSONSchema) {
    throw new Error(
      "z.toJSONSchema is unavailable. Ensure Zod 4 is installed.",
    );
  }

  return zodWithJsonSchema.toJSONSchema(ProjectConfigV1Schema, {
    name: "MetristsProjectConfigV1",
  });
}

export function getSchemaVersionFromUrl(schemaUrl: string): number | null {
  const match = schemaUrl.match(/\/v(\d+)\.schema\.json$/);
  if (!match) return null;
  return Number(match[1]);
}

export function isSupportedProjectConfigSchemaUrl(schemaUrl: string): boolean {
  return PROJECT_CONFIG_SUPPORTED_SCHEMA_URLS.includes(
    schemaUrl as (typeof PROJECT_CONFIG_SUPPORTED_SCHEMA_URLS)[number],
  );
}
