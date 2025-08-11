import { join } from 'path';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');
import { InitCommand } from '../../commands/init.command';

describe('init_command_creates_the_right_files', () => {
  const temp = join(__dirname, 'tmp');
  let tempDirName: string;
  let tempDir: string;
  const timeout = 100000;

  beforeAll(async () => {
    tempDirName = `test-${Date.now()}`;
    tempDir = join(temp, tempDirName);
    mkdirSync(tempDir, { recursive: true });
    await execa('node', ['../../../../dist/bin/metrists.js', 'init'], {
      cwd: tempDir,
    });
  }, timeout);

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  }, timeout);

  it(
    'Should create a .metrists',
    async () => {
      const markdownFilePath = join(tempDir, 'test.md');
      writeFileSync(markdownFilePath, '# Test Markdown File', 'utf-8');

      const metristsDirPath = join(tempDir, '.metrists');
      const directoryExists = existsSync(metristsDirPath);

      expect(directoryExists).toBe(true);
    },
    timeout,
  );

  it(
    '.gitignore should exist and contain .metrists',
    async () => {
      const gitignorePath = join(tempDir, '.gitignore');
      const gitignoreExists = existsSync(gitignorePath);

      expect(gitignoreExists).toBe(true);

      const fileContent = readFileSync(gitignorePath, 'utf-8');
      expect(fileContent).toContain('.metrists');
    },
    timeout,
  );

  it(
    'meta file should exists and contain the right content',
    async () => {
      const metaPath = join(tempDir, 'meta.md');
      const metaExists = existsSync(metaPath);

      expect(metaExists).toBe(true);

      const fileContent = readFileSync(metaPath, 'utf-8');
      expect(fileContent).toContain(`title: ${tempDirName.replace('-', ' ')}`);
    },
    timeout,
  );
});

describe('init command with the example flag copies the right files', () => {
  const temp = join(__dirname, 'tmp');
  let tempDirName: string;
  let tempDir: string;
  let exampleTitle: string;
  const timeout = 100000;
  const example = 'everyone-poops';

  beforeAll(async () => {
    tempDirName = `test-${Date.now()}`;
    tempDir = join(temp, tempDirName);
    mkdirSync(tempDir, { recursive: true });
    await execa(
      'node',
      ['../../../../dist/bin/metrists.js', 'init', '--example', example],
      {
        cwd: tempDir,
      },
    );
  }, timeout);

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  }, timeout);

  it(
    'Should copy the template chapter files',
    async () => {
      const exampleOgDir = join(
        __dirname,
        '..',
        '..',
        '..',
        'examples',
        example,
      );
      const chapters = readdirSync(join(exampleOgDir)).filter(
        (file) =>
          file.endsWith('.md') && !file.endsWith(InitCommand.getMetaFileName()),
      );

      console.log(chapters);
    },
    timeout,
  );

  it(
    '.gitignore should exist and contain .metrists',
    async () => {
      const gitignorePath = join(tempDir, '.gitignore');
      const gitignoreExists = existsSync(gitignorePath);

      expect(gitignoreExists).toBe(true);

      const fileContent = readFileSync(gitignorePath, 'utf-8');
      expect(fileContent).toContain('.metrists');
    },
    timeout,
  );
});
