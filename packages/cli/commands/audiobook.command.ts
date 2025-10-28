import { InitCommand } from './init.command';
import { join } from 'path';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { getElevenLabsService } from '../lib/utils/elevenlabs.util';
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

    const elevenLabsService = getElevenLabsService();
    const audio = await elevenLabsService.convertTextToSpeech(
      'The first move is what sets everything in motion.',
    );

    const outputFilePath = join(
      this.workingDirectory,
      this.outputPath + '.mp3',
    );
    const writeStream = createWriteStream(outputFilePath);

    const readable = Readable.fromWeb(audio);
    readable.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    this.logger.log(
      ['verbose', 'noob'],
      `Audiobook saved to: ${outputFilePath}`,
    );
  }
}
