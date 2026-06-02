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

const DeploySchema = z
  .object({
    provider: WebDeployProviderSchema.nullable().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .default({})
  .transform((value) => ({
    provider: value.provider ?? null,
    options: value.options ?? {},
  }));

const WebOutputSchema = z
  .object({
    enabled: z.boolean().optional(),
    outDir: z.string().min(1).optional(),
    theme: z.string().min(1).optional(),
    deploy: DeploySchema.optional(),
  })
  .strict()
  .default({})
  .transform((value) => ({
    enabled: value.enabled ?? true,
    outDir: value.outDir ?? ".metrists",
    theme: value.theme ?? "metrists-theme-next",
    deploy: value.deploy ?? { provider: null, options: {} },
  }));

const EpubOutputSchema = z
  .object({
    enabled: z.boolean().optional(),
    coverImagePath: z.string().min(1).optional(),
  })
  .strict()
  .default({})
  .transform((value) => ({
    enabled: value.enabled ?? false,
    coverImagePath: value.coverImagePath ?? "cover.jpg",
  }));

const PdfOutputSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .default({})
  .transform((value) => ({
    enabled: value.enabled ?? false,
  }));

const AudiobookOutputSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.literal("elevenlabs").optional(),
    apiKey: SecretValueSchema.optional(),
    voiceId: SecretValueSchema.optional(),
    modelId: z.string().min(1).optional(),
    format: z.string().min(1).optional(),
  })
  .strict()
  .default({})
  .transform((value) => ({
    enabled: value.enabled ?? false,
    provider: value.provider,
    apiKey: value.apiKey,
    voiceId: value.voiceId,
    modelId: value.modelId,
    format: value.format,
  }));

const OutputsSchema = z
  .object({
    web: WebOutputSchema.optional(),
    epub: EpubOutputSchema.optional(),
    pdf: PdfOutputSchema.optional(),
    audiobook: AudiobookOutputSchema.optional(),
  })
  .strict()
  .default({})
  .transform((value) => ({
    web:
      value.web ??
      WebOutputSchema.parse({
        enabled: true,
        outDir: ".metrists",
        theme: "metrists-theme-next",
        deploy: { provider: null, options: {} },
      }),
    epub: value.epub ?? EpubOutputSchema.parse({}),
    pdf: value.pdf ?? PdfOutputSchema.parse({}),
    audiobook: value.audiobook ?? AudiobookOutputSchema.parse({}),
  }));

export const ProjectConfigV1Schema = z
  .object({
    $schema: z.literal(PROJECT_CONFIG_SCHEMA_URL_V1),
    editing: z.object({}).strict().default({}),
    lifecycle: z
      .object({
        git: z.object({}).strict().optional(),
      })
      .strict()
      .default({
        git: {},
      })
      .transform((value) => ({
        git: value.git ?? {},
      })),
    outputs: OutputsSchema,
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

export const ProjectConfigV1PersistedSchema = z
  .object({
    $schema: z.literal(PROJECT_CONFIG_SCHEMA_URL_V1),
    editing: z.object({}).strict().optional(),
    lifecycle: z
      .object({
        git: z.object({}).strict().optional(),
      })
      .strict()
      .optional(),
    outputs: z
      .object({
        web: z
          .object({
            enabled: z.boolean().optional(),
            outDir: z.string().min(1).optional(),
            theme: z.string().min(1).optional(),
            deploy: z
              .object({
                provider: WebDeployProviderSchema.nullable().optional(),
                options: z.record(z.string(), z.unknown()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        epub: z
          .object({
            enabled: z.boolean().optional(),
            coverImagePath: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        pdf: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        audiobook: z
          .object({
            enabled: z.boolean().optional(),
            provider: z.literal("elevenlabs").optional(),
            apiKey: SecretValueSchema.optional(),
            voiceId: SecretValueSchema.optional(),
            modelId: z.string().min(1).optional(),
            format: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ProjectConfigV1Input = z.input<typeof ProjectConfigV1Schema>;
export type ProjectConfigV1Output = z.output<typeof ProjectConfigV1Schema>;

export function createInitialProjectConfigV1(): Pick<
  ProjectConfigV1Input,
  "$schema"
> {
  return {
    $schema: PROJECT_CONFIG_SCHEMA_URL_V1,
  };
}

export function createDefaultProjectConfigV1(): ProjectConfigV1Output {
  return ProjectConfigV1Schema.parse(createInitialProjectConfigV1());
}

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

export function getProjectConfigV1PersistedJsonSchema() {
  const zodWithJsonSchema = z as ZodWithJsonSchema;
  if (!zodWithJsonSchema.toJSONSchema) {
    throw new Error(
      "z.toJSONSchema is unavailable. Ensure Zod 4 is installed.",
    );
  }

  return zodWithJsonSchema.toJSONSchema(ProjectConfigV1PersistedSchema, {
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
