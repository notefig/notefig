import { join } from 'path';
import { ConfigAwareCommand } from './config-aware.command';
import { deleteDirectory, deleteFile, pathExists } from '../lib/utils/fs.util';
import { hostHelpers } from '../lib/utils/hosts.util';
import type { Command } from 'commander';

export class PruneCommand extends ConfigAwareCommand {
  protected workingDirectory: string;
  protected templatePath: string;

  public load(program: Command) {
    return program
      .command('prune')
      .description('Prune the previous version of the build');
  }

  public async handle(_command: Command) {
    await this.loadRcConfig();

    const workingDirectory = process.cwd();
    const outDir = this.getRc((rc) => rc?.outDir);
    const templatePath = join(workingDirectory, outDir);

    let prunedItems = 0;

    for (const [hostName, host] of Object.entries(hostHelpers)) {
      if (
        host.isHostUsed &&
        host.pruneHost &&
        host.isHostUsed(workingDirectory)
      ) {
        try {
          this.logger.info(`Running ${hostName} cleanup...`);
          await host.pruneHost({
            workingDirectory,
            outDir,
            hostOptions: this.getRc((rc) => rc?.hosts?.[hostName] || {}),
            logger: this.logger,
          });
          prunedItems++;
        } catch (error) {
          this.logger.verbose(
            `Failed to run ${hostName} cleanup, continuing with file cleanup`,
          );
        }
      }
    }

    if (pathExists(templatePath)) {
      await deleteDirectory(templatePath);
      this.logger.info('Pruned the previous build');
      prunedItems++;
    } else {
      this.logger.verbose('No previous build found to prune');
    }

    const deletionPromises = [];
    for (const [hostName, host] of Object.entries(hostHelpers)) {
      // Skip hosts that handle their own cleanup via pruneHost
      if (host.pruneHost) {
        continue;
      }

      const configFilePaths = host.getConfigFilePaths();
      for (const configPath of configFilePaths) {
        const fullPath = join(workingDirectory, configPath);
        if (pathExists(fullPath)) {
          deletionPromises.push(
            deleteFile(fullPath)
              .then(() => {
                this.logger.verbose(
                  `Deleted ${hostName} config file: ${configPath}`,
                );
                prunedItems++;
              })
              .catch((error) => {
                this.logger.verbose(
                  `Failed to delete ${configPath}: ${error.message}`,
                );
              }),
          );
        }
      }
    }

    await Promise.all(deletionPromises);

    if (prunedItems > 0) {
      this.logger.info(`Pruned ${prunedItems} items`);
    } else {
      this.logger.info('No items found to prune');
    }
  }
}
