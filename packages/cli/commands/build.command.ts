import { InitCommand } from './init.command';
import {
  copyAllFilesFromOneDirectoryToAnother,
  combinePaths,
} from '../lib/utils/fs.util';
import { makeBook } from '../lib/epub';
import { canMakeAudiobook, makeAudiobook } from '../lib/audiobook';
import type { Command } from 'commander';

export class BuildCommand extends InitCommand {
  public load(program: Command) {
    return program
      .command('build')
      .alias('b')
      .description('Build a production version of the book')
      .option('-o, --out <path>', 'Output directory for the production build')
      .option('--skip-epub', 'Skip EPUB generation')
      .option('--skip-audiobook', 'Skip audiobook generation');
  }

  public async handle(command: ReturnType<typeof BuildCommand.prototype.load>) {
    await super.handle(command);
    const options = command.opts();
    const outputDirRelative = options.out;

    if (!outputDirRelative) {
      throw new Error('Output directory is required');
    }

    await this.buildContentLayer();

    const buildTasks = [];

    if (!options.skipEpub) {
      buildTasks.push(this.buildEpubFile());
    }

    if (!options.skipAudiobook) {
      buildTasks.push(this.buildAudiobookFile());
    }

    await Promise.all(buildTasks);

    await this.buildTemplate();
    await this.copyBuiltContentToOutputDir(outputDirRelative);
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

  protected async buildEpubFile() {
    const metadata = await this.getEpubMetadata();

    makeBook(
      {
        workingDirectory: this.workingDirectory,
        ignoredFiles: [this.metaFileName],
        outputPath: combinePaths([this.templateAssetsPath, 'book.epub']),
      },
      metadata,
      this.logger,
    );
  }

  protected async buildAudiobookFile() {
    //TODO: canMakeAudiobook should return the reason why we can't generate
    if (canMakeAudiobook()) {
      return await makeAudiobook(
        {
          outputPath: combinePaths([this.templateAssetsPath, 'book.mp3']),
          workingDirectory: this.workingDirectory,
          extractProjectMetadata: this.extractProjectMetadata.bind(this),
          shouldIncludeChapterFile: this.shouldIncludeChapterFile.bind(this),
        },
        this.logger,
      );
    } else {
      this.logger.info(
        'No Audiobook Coniguration. Skipping Audiobook generation.',
      );
      return Promise.resolve();
    }
  }
}
