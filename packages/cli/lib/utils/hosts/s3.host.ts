import { join } from 'path';
import { name } from '../../../package.json';
import { createDirectoryIfNotExists, writeToFile } from '../fs.util';
import type { Host, ProjectMetadata } from '../host.interface';

export const s3: Host = {
  deploy: async ({ outDir, metristsBuildCommand, projectMetadata }) => {
    const sstConfigPath = join(process.cwd(), 'sst.config.ts');
    const githubWorkflowsDir = join(process.cwd(), '.github', 'workflows');
    const githubActionConfig = join(githubWorkflowsDir, 'deploy.yml');

    await createDirectoryIfNotExists(githubWorkflowsDir);

    await Promise.all([
      writeToFile(
        sstConfigPath,
        getSstConfig(metristsBuildCommand, outDir, projectMetadata),
      ),
      writeToFile(githubActionConfig, getGithubAction()),
    ]);

    return {
      createdFiles: [
        'sst.config.ts',
        join('.github', 'workflows', 'deploy.yml'),
      ],
    };
  },
  'getConfigFilePaths': () => [
    'sst.config.ts',
    join('.github', 'workflows', 'deploy.yml'),
  ],
};

function getGithubAction() {
  return `name: Deploy to Production
on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \$\{\{ secrets.AWS_ACCESS_KEY_ID \}\}
          aws-secret-access-key: \$\{{ secrets.AWS_SECRET_ACCESS_KEY \}\}
          aws-region: us-east-1
          
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install SST CLI
        run: npm install -g sst
        
      - name: Initialize metrists template
        run: npx metrists@0.5.0 init
        
      - name: Deploy to production
        run: sst deploy --stage production
`;
}

function getSstConfig(
  buildCommand: string,
  outDir: string,
  projectMetadata?: ProjectMetadata,
) {
  const titleEscaped = projectMetadata
    ? `${projectMetadata.title.replace(/-/g, '')}`
    : 'MetristsSite';

  return `/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "${titleEscaped}",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    try {
      return new sst.aws.StaticSite("${titleEscaped}", {
        build: {
          command: "${buildCommand}",
          output: "${outDir}",
        },
        invalidation: {
          paths: "all",
          wait: true,
        },
      });
    } catch (e) {
      console.error(e);
      throw e;
    }
  },
});
`;
}
