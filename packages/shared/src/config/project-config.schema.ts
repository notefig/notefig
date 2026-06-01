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
    provider: value.provider ?? "elevenlabs",
    apiKey: value.apiKey ?? "$ELEVENLABS_API_KEY",
    voiceId: value.voiceId ?? "$ELEVENLABS_VOICE_ID",
    modelId: value.modelId ?? "eleven_multilingual_v2",
    format: value.format ?? "mp3_44100_128",
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
    editing: z
      .object({
        textDirection: z.enum(["ltr", "rtl"]).optional(),
      })
      .strict()
      .default({})
      .transform((value) => ({
        textDirection: value.textDirection ?? "ltr",
      })),
    lifecycle: z
      .object({
        git: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .default({ enabled: true })
          .transform((value) => ({
            enabled: value.enabled ?? true,
          })),
      })
      .strict()
      .default({ git: { enabled: true } })
      .transform((value) => ({
        git: value.git ?? { enabled: true },
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

export type ProjectConfigV1Input = z.input<typeof ProjectConfigV1Schema>;
export type ProjectConfigV1Output = z.output<typeof ProjectConfigV1Schema>;

export function createDefaultProjectConfigV1(): ProjectConfigV1Output {
  return ProjectConfigV1Schema.parse({
    $schema: PROJECT_CONFIG_SCHEMA_URL_V1,
  });
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
