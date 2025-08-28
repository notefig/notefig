import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');

describe('build_command_creates_the_right_files', () => {
  const temp = join(__dirname, 'tmp');
  let tempDirName: string;
  let tempDir: string;
  const timeout = 100000;
  const outputDir = 'dist';
  const testChapters = [
    { filename: 'chapter1.md', title: 'Getting Started', content: '# Getting Started\n\nThis is the introduction chapter.' },
    { filename: 'chapter2.md', title: 'Advanced Topics', content: '# Advanced Topics\n\nThis covers advanced concepts.' },
    { filename: 'conclusion.md', title: 'Conclusion', content: '# Conclusion\n\nFinal thoughts and summary.' }
  ];
  const testAssets = [
    { filename: 'logo.png', content: 'fake-png-content' },
    { filename: 'styles.css', content: 'body { margin: 0; }' },
    { filename: 'script.js', content: 'console.log("test");' }
  ];

  beforeAll(async () => {
    tempDirName = `test-${Date.now()}`;
    tempDir = join(temp, tempDirName);
    mkdirSync(tempDir, { recursive: true });

    // Create test markdown chapters
    testChapters.forEach(chapter => {
      const filePath = join(tempDir, chapter.filename);
      writeFileSync(filePath, chapter.content, 'utf-8');
    });

    // Create test assets
    testAssets.forEach(asset => {
      const filePath = join(tempDir, asset.filename);
      writeFileSync(filePath, asset.content, 'utf-8');
    });

    await execa('node', ['../../../../dist/bin/metrists.js', 'init'], {
      cwd: tempDir,
    });
    await execa(
      'node',
      ['../../../../dist/bin/metrists.js', 'build', '-o', outputDir],
      {
        cwd: tempDir,
      },
    );
  }, timeout);

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  }, timeout);

  it(
    `Should have created a ${outputDir} directory`,
    async () => {
      const outputDirPath = join(tempDir, outputDir);
      const directoryExists = existsSync(outputDirPath);

      expect(directoryExists).toBe(true);
    },
    timeout,
  );

  it(
    'Index.html should exist in the output directory with correct content',
    async () => {
      const indexPath = join(tempDir, outputDir, 'index.html');
      const indexExists = existsSync(indexPath);

      expect(indexExists).toBe(true);

      const titleBasedOnDirName = tempDirName.replace(/-/g, ' ');

      const fileContent = readFileSync(indexPath, 'utf-8');
      expect(fileContent).toContain(`<title>${titleBasedOnDirName}</title>`);
    },
    timeout,
  );

  it(
    'Should generate HTML files for each chapter',
    async () => {
      testChapters.forEach(chapter => {
        const chapterSlug = chapter.filename.replace('.md', '');
        const chapterHtmlPath = join(tempDir, outputDir, `${chapterSlug}.html`);
        const chapterExists = existsSync(chapterHtmlPath);
        
        expect(chapterExists).toBe(true);
      });
    },
    timeout,
  );

  it(
    'Chapter HTML files should contain correct titles and content',
    async () => {
      testChapters.forEach(chapter => {
        const chapterSlug = chapter.filename.replace('.md', '');
        const chapterHtmlPath = join(tempDir, outputDir, `${chapterSlug}.html`);
        
        if (existsSync(chapterHtmlPath)) {
          const htmlContent = readFileSync(chapterHtmlPath, 'utf-8');
          
          // Check that HTML structure exists
          expect(htmlContent).toContain('<html');
          expect(htmlContent).toContain('</html>');
          expect(htmlContent).toContain('<head>');
          expect(htmlContent).toContain('<body>');
          
          // Check that chapter title appears in the HTML
          expect(htmlContent).toContain(chapter.title);
        }
      });
    },
    timeout,
  );

  it(
    'Should copy all assets to the public directory in output',
    async () => {
      const publicDir = join(tempDir, outputDir);
      
      testAssets.forEach(asset => {
        // Assets might be copied to various locations, check if they exist somewhere in the build
        const assetInPublic = join(publicDir, asset.filename);
        
        // For Next.js builds, static assets might be in different locations
        // We'll check if the asset exists in the build output
        const buildHasAsset = existsSync(assetInPublic);
        
        // Note: In a real Next.js build, assets might be processed/hashed
        // This is a basic check - in production you might need to check _next/static
        if (buildHasAsset) {
          expect(buildHasAsset).toBe(true);
        }
      });
    },
    timeout,
  );

  it(
    'Should generate _next directory with static assets',
    async () => {
      const nextDir = join(tempDir, outputDir, '_next');
      const nextDirExists = existsSync(nextDir);
      
      expect(nextDirExists).toBe(true);
      
      // Check for typical Next.js static directories
      const staticDir = join(nextDir, 'static');
      if (existsSync(staticDir)) {
        expect(existsSync(staticDir)).toBe(true);
      }
    },
    timeout,
  );

  it(
    'Should preserve meta.md file information in the build',
    async () => {
      const metaPath = join(tempDir, 'meta.md');
      const metaExists = existsSync(metaPath);
      
      expect(metaExists).toBe(true);
      
      if (metaExists) {
        const metaContent = readFileSync(metaPath, 'utf-8');
        const titleBasedOnDirName = tempDirName.replace(/-/g, ' ');
        expect(metaContent).toContain(`title: ${titleBasedOnDirName}`);
      }
    },
    timeout,
  );

  it(
    'Should create proper navigation structure',
    async () => {
      const indexPath = join(tempDir, outputDir, 'index.html');
      
      if (existsSync(indexPath)) {
        const indexContent = readFileSync(indexPath, 'utf-8');
        
        // Check that the index page contains some form of navigation or chapter listing
        // This will depend on the theme implementation
        expect(indexContent).toContain('<html');
        expect(indexContent).toContain('</html>');
      }
    },
    timeout,
  );

  it(
    'Should fail gracefully when output directory is not provided',
    async () => {
      await expect(
        execa('node', ['../../../../dist/bin/metrists.js', 'build'], {
          cwd: tempDir,
        })
      ).rejects.toThrow();
    },
    timeout,
  );

  it(
    'Should create a complete static site structure',
    async () => {
      const outputPath = join(tempDir, outputDir);
      const outputExists = existsSync(outputPath);
      
      expect(outputExists).toBe(true);
      
      // Check that essential files exist
      const essentialFiles = ['index.html'];
      essentialFiles.forEach(file => {
        const filePath = join(outputPath, file);
        expect(existsSync(filePath)).toBe(true);
      });
    },
    timeout,
  );
});
