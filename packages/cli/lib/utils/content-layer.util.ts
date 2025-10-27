import { userInfo } from 'os';
import { z } from 'zod';

export const MetaDocumentFrontmatter = z.object({
  title: z.string(),
  author: z.string(),
  date: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type MetaDocumentFrontmatterInterface = z.infer<
  typeof MetaDocumentFrontmatter
>;

const ChapterDocumentFrontmatter = z.object({
  title: z.string(),
  index: z.number(),
  author: z.string().optional(),
  date: z.string().date().optional(),
  updated: z.string().date().optional(),
});

export function getArbitraryMeta(
  directoryName: string,
): z.infer<typeof MetaDocumentFrontmatter> {
  return {
    title: getSanitizedTitle(directoryName),
    author: getCurrentUsername(),
    date: getCurrentDate(),
    tags: ['novel'],
  };
}

export function getArbitraryChapter(
  fileName: string,
  index: number,
): z.infer<typeof ChapterDocumentFrontmatter> {
  return {
    title: getSanitizedTitle(fileName),
    index,
    author: getCurrentUsername(),
    date: getCurrentDate(),
    updated: getCurrentDate(),
  };
}

export function validateMetaDocumentFrontmatter(frontmatter: any) {
  return MetaDocumentFrontmatter.safeParse(frontmatter);
}

export function validateChapterDocumentFrontmatter(frontmatter: any) {
  return ChapterDocumentFrontmatter.safeParse(frontmatter);
}

function getCurrentUsername() {
  return userInfo().username;
}

function getCurrentDate() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const year = now.getFullYear();
  return `${year}-${month.toString().length > 1 ? month : '0' + month}-${
    date.toString().length > 1 ? date : '0' + date
  }`;
}

function getSanitizedTitle(filename: string) {
  return filename
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
