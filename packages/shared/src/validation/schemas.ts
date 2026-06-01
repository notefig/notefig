// Shared Zod schemas for validation

import { z } from "zod";
import { ProjectConfigV1Schema } from "../config/project-config.schema";

export const ProjectConfigSchema = ProjectConfigV1Schema;

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
  metadata: z.record(z.string(), z.unknown()),
  frontmatter: z.record(z.string(), z.unknown()),
});
