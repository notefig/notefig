import { join } from 'path';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');
import * as JSZip from 'jszip';
import { createUniqueTempDir, cleanupTempDir, getCliPath } from './test-helpers';

describe('epub_command_generates_valid_epub', () => {
  let tempDir: string;
  const timeout = 300000; // 5 minutes for long-running init with npm install
  const setupTimeout = 300000; // Separate timeout for beforeAll

  beforeAll(async () => {
    tempDir = createUniqueTempDir('epub');

    // Create test markdown files with frontmatter
    const chapter1Content = `---
title: "Chapter 1: The Beginning"
---

# The First Chapter

This is the beginning of our story.

## Section 1.1

Some content here with **bold text** and *italic text*.
`;

    const chapter2Content = `---
title: "Chapter 2: The Journey"
---

# The Second Chapter

The journey continues with more adventures.

![Test Image](test-image.png)

## Section 2.1

More content here.
`;

    const metaContent = `---
title: Test Book Title
author: Test Author
description: A test book for e2e testing
language: en
cover: cover.jpg
tags:
  - test
  - epub
  - ebook
---

# About This Book

This book is created for testing the EPUB generation functionality.
`;

    // Write markdown files
    writeFileSync(join(tempDir, 'chapter-1.md'), chapter1Content, 'utf-8');
    writeFileSync(join(tempDir, 'chapter-2.md'), chapter2Content, 'utf-8');
    writeFileSync(join(tempDir, 'meta.md'), metaContent, 'utf-8');

    // Create a simple test image (1x1 pixel PNG)
    const testImageBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(tempDir, 'test-image.png'), testImageBuffer as any);

    // Create a simple cover image
    writeFileSync(join(tempDir, 'cover.jpg'), testImageBuffer as any);

    // Initialize metrists project
    await execa('node', [getCliPath(), 'init'], {
      cwd: tempDir,
    });
  }, setupTimeout);

  afterAll(() => {
    cleanupTempDir(tempDir);
  }, timeout);

  it(
    'Should generate a valid EPUB file with correct structure',
    async () => {
      const outputPath = join(tempDir, 'output.epub');

      // Run the epub command (use relative path)
      await execa(
        'node',
        [getCliPath(), 'epub', '--out', 'output.epub'],
        {
          cwd: tempDir,
        },
      );

      // Verify the EPUB file was created
      expect(existsSync(outputPath)).toBe(true);

      // Read and validate the EPUB file using JSZip
      const epubBuffer = readFileSync(outputPath);
      const zip = await JSZip.loadAsync(epubBuffer as any);

      // Verify EPUB 3.3 compliance - check required files
      expect(zip.files['mimetype']).toBeDefined();
      expect(zip.files['META-INF/container.xml']).toBeDefined();
      expect(zip.files['EPUB/content.opf']).toBeDefined();
      expect(zip.files['EPUB/nav.xhtml']).toBeDefined();

      // Verify mimetype content
      const mimetypeContent = await zip.files['mimetype'].async('text');
      expect(mimetypeContent).toBe('application/epub+zip');

      // Verify container.xml structure
      const containerContent = await zip.files['META-INF/container.xml'].async('text');
      expect(containerContent).toContain('EPUB/content.opf');
      expect(containerContent).toContain('application/oebps-package+xml');

      // Verify content.opf structure and EPUB 3.3 compliance
      const opfContent = await zip.files['EPUB/content.opf'].async('text');
      expect(opfContent).toContain('version="3.0"');
      expect(opfContent).toContain('xmlns:dcterms="http://purl.org/dc/terms/"');
      expect(opfContent).toContain('dcterms:modified');
      expect(opfContent).toContain('<meta name="cover" content="cover-image"/>');
      expect(opfContent).toContain('Test Book Title');
      expect(opfContent).toContain('Test Author');
      
      // Verify no deprecated NCX references
      expect(opfContent).not.toContain('toc.ncx');
      expect(opfContent).not.toContain('application/x-dtbncx+xml');
      expect(opfContent).not.toContain('<guide>');

      // Verify navigation document
      const navContent = await zip.files['EPUB/nav.xhtml'].async('text');
      expect(navContent).toContain('epub:type="toc"');
      expect(navContent).toContain('epub:type="landmarks"');
      expect(navContent).toContain('Chapter 1: The Beginning');
      expect(navContent).toContain('Chapter 2: The Journey');

      // Verify chapter files exist and contain frontmatter titles
      expect(zip.files['EPUB/chapter-1.xhtml']).toBeDefined();
      expect(zip.files['EPUB/chapter-2.xhtml']).toBeDefined();

      const chapter1Content = await zip.files['EPUB/chapter-1.xhtml'].async('text');
      expect(chapter1Content).toContain('The First Chapter');
      expect(chapter1Content).toContain('This is the beginning of our story');
      expect(chapter1Content).toContain('<strong>bold text</strong>');
      expect(chapter1Content).toContain('<em>italic text</em>');

      const chapter2Content = await zip.files['EPUB/chapter-2.xhtml'].async('text');
      expect(chapter2Content).toContain('The Second Chapter');
      expect(chapter2Content).toContain('test-image.png');

      // Verify cover and title page
      expect(zip.files['EPUB/cover.xhtml']).toBeDefined();
      expect(zip.files['EPUB/title_page.xhtml']).toBeDefined();

      const coverContent = await zip.files['EPUB/cover.xhtml'].async('text');
      expect(coverContent).toContain('cover.jpg');

      const titlePageContent = await zip.files['EPUB/title_page.xhtml'].async('text');
      expect(titlePageContent).toContain('Test Book Title');
      expect(titlePageContent).toContain('Test Author');

      // Verify images are included
      expect(zip.files['EPUB/test-image.png']).toBeDefined();
      expect(zip.files['EPUB/cover.jpg']).toBeDefined();

      // Verify stylesheet
      expect(zip.files['EPUB/stylesheet.css']).toBeDefined();
      const stylesheetContent = await zip.files['EPUB/stylesheet.css'].async('text');
      expect(stylesheetContent).toContain('body');
      expect(stylesheetContent).toContain('font-size');

      // Verify no deprecated NCX file exists
      expect(zip.files['EPUB/toc.ncx']).toBeUndefined();

      // Verify manifest includes cover image with proper properties
      expect(opfContent).toContain('properties="cover-image"');
      expect(opfContent).toContain('image/jpeg');
      expect(opfContent).toContain('image/png');
    },
    timeout,
  );
});