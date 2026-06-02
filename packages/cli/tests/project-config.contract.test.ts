import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import {
  parseProjectConfig,
  PROJECT_CONFIG_SCHEMA_URL_V1,
} from '@metrists/shared';

describe('project-config contract (cli)', () => {
  it('parses shared canonical schema fixture', () => {
    const fixturePath = join(
      process.cwd(),
      '..',
      '..',
      'schemas',
      'project-config',
      'v1.schema.json',
    );
    const schemaRaw = readFileSync(fixturePath, 'utf8');
    const schemaJson = JSON.parse(schemaRaw);

    expect(schemaJson).toBeDefined();
    expect(schemaJson.$schema).toBeDefined();

    const parsed = parseProjectConfig(
      JSON.stringify({
        $schema: PROJECT_CONFIG_SCHEMA_URL_V1,
      }),
    );

    expect(parsed.$schema).toBe(PROJECT_CONFIG_SCHEMA_URL_V1);
  });
});
