// Shared Zod schemas for validation

import { z } from "zod";

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  basePath: z.string(),
  settings: z.object({
    textDirection: z.enum(["ltr", "rtl"]).optional(),
    language: z.string().optional(),
  }),
});

export const FileMetadataSchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(["file", "directory"]),
  size: z.number().optional(),
  modified: z.date().optional(),
  contentHash: z.string().optional(),
});

export const ParsedContentSchema = z.object({
  content: z.string(),
  metadata: z.record(z.unknown()),
  frontmatter: z.record(z.unknown()),
});


