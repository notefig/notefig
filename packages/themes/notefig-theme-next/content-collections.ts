import {
  defineCollection,
  defineConfig,
  defineSingleton,
} from "@content-collections/core";
import { compileMarkdown } from "@content-collections/markdown";
import highlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { z } from "zod";

export const contentDirectory = "content";
export const metaFileName = "meta";
export const metaPath = `${metaFileName}.md`;

const markdownOptions = {
  rehypePlugins: [highlight],
  remarkPlugins: [remarkGfm],
};

const chapters = defineCollection({
  name: "chapters",
  directory: contentDirectory,
  include: "**/*.md",
  exclude: `**/${metaPath}`,
  schema: z.object({
    title: z.string(),
    index: z.number(),
    date: z.string().optional(),
    author: z.string().optional(),
    updated: z.string().optional(),
    content: z.string(),
  }),
  transform: async (document, context) => ({
    ...document,
    slug: document._meta.path,
    url: `/chapters/${document._meta.path}`,
    authors: document.author ? document.author.split(",") : null,
    body: {
      raw: document.content,
      html: await compileMarkdown(context, document, markdownOptions),
    },
  }),
});

const meta = defineSingleton({
  name: "meta",
  filePath: `${contentDirectory}/${metaPath}`,
  schema: z.object({
    title: z.string(),
    author: z.string(),
    date: z.string().optional(),
    tags: z.array(z.string()).optional().default([]),
    content: z.string(),
  }),
  transform: async (document, context) => ({
    ...document,
    authors: document.author.split(","),
    body: {
      raw: document.content,
      html: await compileMarkdown(context, document, markdownOptions),
    },
  }),
});

export default defineConfig({
  content: [chapters, meta],
});