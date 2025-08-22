import { InitCommand } from './init.command';
import { spawnAndWait } from '../lib/utils/process.util';
import {
  copyAllFilesFromOneDirectoryToAnother,
  combinePaths,
} from '../lib/utils/fs.util';
import type { Command } from 'commander';

export class BuildCommand extends InitCommand {
  public load(program: Command) {
    return program
      .command('build')
      .alias('b')
      .description('Build a production version of the book')
      .option('-o, --out <path>', 'Output directory for the production build');
  }

  public async handle(command: ReturnType<typeof BuildCommand.prototype.load>) {
    await super.handle(command);
    const outputDirRelative = command.opts().out;

    if (!outputDirRelative) {
      throw new Error('Output directory is required');
    }

    await this.buildContentLayer()
      .then(this.buildTemplate.bind(this))
      .then(() => this.copyBuiltContentToOutputDir(outputDirRelative));
  }

  protected async buildTemplate() {
    const buildScript = this.getTemplateConfig((rc) => rc?.buildScript).split(
      ' ',
    );
    return this.spawnAndWaitAndStopIfError(
      buildScript[0],
      buildScript.slice(1),
      {
        cwd: this.templatePath,
      },
    );
  }

  protected async copyBuiltContentToOutputDir(finalOutDir: string) {
    const templateOutFullPath = this.getFinalTemplateOutputPath();
    return await copyAllFilesFromOneDirectoryToAnother(
      templateOutFullPath,
      finalOutDir,
      () => true,
    );
  }

  protected async buildContentLayer() {
    const buildContentScript = this.getTemplateConfig(
      (rc) => rc?.buildContentScript,
    );

    if (buildContentScript) {
      const buildContentScriptParts = buildContentScript.split(' ');
      return this.spawnAndWaitAndStopIfError(
        buildContentScriptParts[0],
        buildContentScriptParts.slice(1),
        {
          cwd: this.templatePath,
        },
      );
    }
    return Promise.resolve();
  }
}
