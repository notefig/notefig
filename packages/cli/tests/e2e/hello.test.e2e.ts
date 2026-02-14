import { describe, expect, it } from '@jest/globals';
import execa = require('execa');

describe('hello_command_greets_the_user', () => {
  const timeout = 30000;

  it(
    'Should display a welcome message',
    async () => {
      const { stdout } = await execa(
        'node',
        ['../../dist/bin/metrists.js', 'hello'],
        {
          cwd: __dirname,
        },
      );

      expect(stdout).toContain('Welcome to Metrists!');
      expect(stdout).toContain(
        'Metrists is a Continuous Deployment pipeline for your books.',
      );
      expect(stdout).toContain('metrists init');
      expect(stdout).toContain('metrists watch --noob');
      expect(stdout).toContain('metrists publish');
      expect(stdout).toContain('https://metrists.com/docs');
    },
    timeout,
  );

  it(
    'Should work with the "hi" alias',
    async () => {
      const { stdout } = await execa(
        'node',
        ['../../dist/bin/metrists.js', 'hi'],
        {
          cwd: __dirname,
        },
      );

      expect(stdout).toContain('Welcome to Metrists!');
    },
    timeout,
  );
});
