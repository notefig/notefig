import { join } from 'path';
import {
  createDirectoryIfNotExists,
  writeToFile,
  pathExists,
  deleteFile,
} from '../fs.util';
import { spawnAndWait } from '../process.util';
import type { Host, ProjectMetadata } from '../host.interface';

export const s3: Host = {
  deploy: async ({ outDir, metristsBuildCommand, projectMetadata, logger }) => {
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

    logger.info('Running SST deployment...');
    await spawnAndWait(
      logger,
      'sst',
      ['deploy', '--stage', 'production'],
      { cwd: process.cwd() },
      { logLevel: 'info' },
    );

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
  isHostUsed: (workingDirectory) => {
    const sstFolder = join(workingDirectory, '.sst');
    return pathExists(sstFolder);
  },
  pruneHost: async ({ workingDirectory, logger }) => {
    logger.info('Running SST remove...');

    // Track if SST remove was successful by spying on stdout
    let sstRemoveSuccessful = false;
    // TODO: Replace with actual SST success pattern once we know the exact output
    const sstSuccessRegexes = [
      /removed successfully/i,
      /stack deleted/i,
      /removal completed/i,
      /✓.*removed/i,
    ];

    try {
      await spawnAndWait(
        logger,
        'sst',
        ['remove', '--stage', 'production'],
        { cwd: workingDirectory },
        {
          logLevel: 'info',
          stdOutListener: (data, next) => {
            const output = data.toString();
            // Check if any success pattern matches
            const isSuccessful = sstSuccessRegexes.some((regex) =>
              regex.test(output),
            );
            if (isSuccessful) {
              sstRemoveSuccessful = true;
            }
            next(data);
          },
        },
      );

      logger.info('SST resources removed');

      // Only delete config files if SST remove was successful
      if (sstRemoveSuccessful) {
        logger.verbose('SST remove successful, deleting config files...');
        const configFilePaths = s3.getConfigFilePaths();
        const deletionPromises = configFilePaths.map(async (configPath) => {
          const fullPath = join(workingDirectory, configPath);
          if (pathExists(fullPath)) {
            try {
              await deleteFile(fullPath);
              logger.verbose(`Deleted S3 config file: ${configPath}`);
            } catch (error) {
              logger.verbose(
                `Failed to delete ${configPath}: ${error.message}`,
              );
            }
          }
        });
        await Promise.all(deletionPromises);
      } else {
        logger.warn(
          'SST remove may not have completed successfully, keeping config files',
        );
      }
    } catch (error) {
      logger.error('SST remove failed, keeping config files');
      throw error;
    }
  },
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
        run: npx metrists init
        
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
