import { InitCommand } from './init.command';
import { join } from 'path';
import { canMakeAudiobook, makeAudiobook } from '../lib/audiobook';
import type { Command } from 'commander';

export class AudiobookCommand extends InitCommand {
  protected outputPath?: string;

  public load(program: Command) {
    return program
      .command('audiobook')
      .alias('ab')
      .option('-o, --out <path>', 'Output path for the audiobook');
  }

  public async handle(command: Command) {
    const options = command.opts();
    this.outputPath = options.out;

    if (!this.outputPath) {
      this.logger.error('Output path is required for audiobook command');
      process.exit(1);
    }
    await super.handle(command);
    const config = this.getRc((rc) => rc);
    if (!canMakeAudiobook(config)) {
      this.logger.error(
        'Audiobook generation is not configured. Enable outputs.audiobook.enabled and set outputs.audiobook.apiKey or ELEVENLABS_API_KEY environment variable.',
      );
      process.exit(1);
    }
    const extension = this.outputPath.endsWith('.mp3') ? '' : '.mp3';
    const outputFilePath = join(
      this.workingDirectory,
      this.outputPath + extension,
    );
    await makeAudiobook(
      {
        outputPath: outputFilePath,
        config,
        workingDirectory: this.workingDirectory,
        extractProjectMetadata: this.extractProjectMetadata.bind(this),
        shouldIncludeChapterFile: this.shouldIncludeChapterFile.bind(this),
      },
      this.logger,
    );
  }
}
