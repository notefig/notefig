import { InitCommand } from './init.command';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { Command } from 'commander';
import { join } from 'path';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { ElevenLabsException } from '../exceptions/elevenlabs.exception';

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

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    if (!apiKey) {
      throw new ElevenLabsException(
        'ELEVENLABS_API_KEY environment variable is required',
      );
    }

    if (!voiceId) {
      throw new ElevenLabsException(
        'ELEVENLABS_VOICE_ID environment variable is required',
      );
    }

    const elevenlabs = new ElevenLabsClient({
      apiKey,
    });

    let audio: any;
    try {
      audio = await elevenlabs.textToSpeech.convert(voiceId, {
        outputFormat: 'mp3_44100_128',
        text: 'Sample Content',
        modelId: 'eleven_multilingual_v2',
      });
    } catch (error: any) {
      if (error.statusCode && error.body?.detail?.message) {
        throw new ElevenLabsException(
          error.body.detail.message,
          error.statusCode,
        );
      }
      throw new ElevenLabsException(
        error.message || 'Unknown ElevenLabs API error',
      );
    }

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
