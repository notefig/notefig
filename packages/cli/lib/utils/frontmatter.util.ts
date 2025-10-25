import { dump, load } from 'js-yaml';
import { EOL } from 'os';

export type Frontmatter = Record<string, any> | Array<any>;

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
export function serializeFrontmatter(frontmatter: Frontmatter) {
  return `---${EOL}${dump(frontmatter)}---${EOL}`;
}

export function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return null;
  }

  const frontmatter = match[1];

  return load(frontmatter);
}

export function replaceFrontmatter(content: string, frontmatter: Frontmatter) {
  const frontmatterString = serializeFrontmatter(frontmatter);
  return content.replace(FRONTMATTER_REGEX, frontmatterString);
}

export function hasFrontmatter(fileContent: string) {
  return fileContent.startsWith('---');
}

export function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_REGEX, '');
}
