#!/usr/bin/env node
import { ensureSupportedNodeVersion } from '../lib/utils/version.util';
import { program } from 'commander';
import * as path from 'path';
import { CommandLoader } from '../commands';
import {
  loadLocalBinCommandLoader,
  localBinExists,
} from '../lib/utils/local-binaries.util';

const bootstrap = () => {
  ensureSupportedNodeVersion();
  const currentWorkingDirectory = __dirname;

  const packageJsonPaths = path.join(
    ...[
      currentWorkingDirectory,
      ...(currentWorkingDirectory.search('/dist') === -1
        ? ['..']
        : ['..', '..']),
      'package.json',
    ],
  );

  program
    .version(
      // eslint-disable-next-line
      require(packageJsonPaths).version,
      '-v, --version',
      'Output the current version.',
    )
    .option('--noob', 'Log only noob messages')
    .option('--verbose', 'log all messages')
    .usage('<command> [options]')
    .helpOption('-h, --help', 'Output usage information.');

  if (localBinExists()) {
    const localCommandLoader = loadLocalBinCommandLoader();
    localCommandLoader.load(program);
  } else {
    CommandLoader.load(program);
  }
  program.parse(process.argv);

  if (!process.argv.slice(2).length) {
    program.outputHelp();
  }
};

bootstrap();
