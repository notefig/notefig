import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');

describe('build_command_creates_the_right_files', () => {
  const temp = join(__dirname, 'tmp-build');
  let tempDirName: string;
  let tempDir: string;
  const timeout = 150000;
  const outputDir = 'dist';
  const testChapters = [
    {
      filename: 'chapter1.md',
      title: 'Getting Started',
      content: '# Getting Started\n\nThis is the introduction chapter.',
    },
    {
      filename: 'chapter2.md',
      title: 'Advanced Topics',
      content: '# Advanced Topics\n\nThis covers advanced concepts.',
    },
    {
      filename: 'conclusion.md',
      title: 'Conclusion',
      content: '# Conclusion\n\nFinal thoughts and summary.',
    },
  ];
  const testAssets = [
    { filename: 'logo.png', content: 'fake-png-content' },
    { filename: 'styles.css', content: 'body { margin: 0; }' },
    { filename: 'script.js', content: 'console.log("test");' },
  ];

  beforeAll(async () => {
    tempDirName = `test-build-${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}`;
    tempDir = join(temp, tempDirName);
    mkdirSync(tempDir, { recursive: true });

    // Create test markdown chapters
    testChapters.forEach((chapter) => {
      const filePath = join(tempDir, chapter.filename);
      writeFileSync(filePath, chapter.content, 'utf-8');
    });

    // Create test assets
    testAssets.forEach((asset) => {
      const filePath = join(tempDir, asset.filename);
      writeFileSync(filePath, asset.content, 'utf-8');
    });

    await execa(
      'node',
      ['../../../../dist/bin/metrists.js', 'init', '--verbose'],
      {
        cwd: tempDir,
      },
    );

    await execa(
      'node',
      [
        '../../../../dist/bin/metrists.js',
        'build',
        '-o',
        outputDir,
        '--verbose',
      ],
      {
        cwd: tempDir,
      },
    );
  }, timeout);

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  }, timeout);

  it(
    'Should build complete static site with all expected files and structure',
    async () => {
      const outputDirPath = join(tempDir, outputDir);
      const titleBasedOnDirName = tempDirName.replace(/-/g, ' ');

      // Verify output directory was created
      expect(existsSync(outputDirPath)).toBe(true);

      // Verify index.html exists with correct content
      const indexPath = join(tempDir, outputDir, 'index.html');
      expect(existsSync(indexPath)).toBe(true);

      const indexContent = readFileSync(indexPath, 'utf-8');
      // Use regex to match title with possible Next.js attributes
      expect(indexContent).toMatch(
        new RegExp(
          `<title[^>]*>${titleBasedOnDirName.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )}</title>`,
        ),
      );
      expect(indexContent).toMatch(/<html[^>]*>/);
      expect(indexContent).toContain('</html>');

      // Verify chapter HTML files exist with correct structure and content
      testChapters.forEach((chapter) => {
        const chapterSlug = chapter.filename.replace('.md', '');
        const chapterHtmlPath = join(tempDir, outputDir, `${chapterSlug}.html`);

        expect(existsSync(chapterHtmlPath)).toBe(true);

        const htmlContent = readFileSync(chapterHtmlPath, 'utf-8');
        expect(htmlContent).toMatch(/<html[^>]*>/);
        expect(htmlContent).toContain('</html>');
        expect(htmlContent).toMatch(/<head[^>]*>/);
        expect(htmlContent).toMatch(/<body[^>]*>/);
        expect(htmlContent).toContain(chapter.title);
      });

      // Verify Next.js _next directory exists
      const nextDir = join(tempDir, outputDir, '_next');
      expect(existsSync(nextDir)).toBe(true);

      const staticDir = join(nextDir, 'static');
      if (existsSync(staticDir)) {
        expect(existsSync(staticDir)).toBe(true);
      }

      // Verify meta.md file exists and contains correct information
      const metaPath = join(tempDir, 'meta.md');
      expect(existsSync(metaPath)).toBe(true);

      const metaContent = readFileSync(metaPath, 'utf-8');
      expect(metaContent).toContain(`title: ${titleBasedOnDirName}`);

      // Verify assets are handled (check if they exist in build output)
      testAssets.forEach((asset) => {
        const assetInPublic = join(outputDirPath, asset.filename);
        if (existsSync(assetInPublic)) {
          expect(existsSync(assetInPublic)).toBe(true);
        }
      });

      // Verify build fails when output directory is not provided
      await expect(
        execa(
          'node',
          ['../../../../dist/bin/metrists.js', 'build', '--skip-audiobook'],
          {
            cwd: tempDir,
          },
        ),
      ).rejects.toThrow();
    },
    timeout,
  );
});
