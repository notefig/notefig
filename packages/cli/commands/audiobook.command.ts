import { InitCommand } from './init.command';
import { join } from 'path';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { getElevenLabsService } from '../lib/utils/elevenlabs.util';
import { validateChapterDocumentFrontmatter } from '../lib/utils/content-layer.util';
import { getContentsRecursively, readFile } from '../lib/utils/fs.util';
import {
  parseFrontmatter,
  stripFrontmatter,
} from '../lib/utils/frontmatter.util';
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

    const entireContent = await this.getTheEntireContent();

    if (!entireContent.trim()) {
      this.logger.error('No chapter content found to convert to audiobook');
      process.exit(1);
    }

    this.logger.log(
      ['verbose', 'noob'],
      `Streaming ${entireContent.length} characters to audiobook...`,
    );

    const elevenLabsService = getElevenLabsService();

    this.logger.log(
      ['verbose', 'noob'],
      'Initiating streaming connection to ElevenLabs...',
    );
    const audio = await elevenLabsService.streamTextToSpeech(entireContent);

    const outputFilePath = join(
      this.workingDirectory,
      this.outputPath + '.mp3',
    );
    const writeStream = createWriteStream(outputFilePath);

    this.logger.log(['verbose', 'noob'], 'Starting audio stream processing...');
    const readable = Readable.fromWeb(audio);
    readable.pipe(writeStream);

    let bytesWritten = 0;
    readable.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten % 10240 === 0) {
        this.logger.log(
          ['verbose'],
          `Streaming progress: ${Math.round(bytesWritten / 1024)}KB processed`,
        );
      }
    });

    await new Promise((resolve, reject) => {
      readable.on('end', () => {
        this.logger.log(
          ['verbose', 'noob'],
          `Stream completed. Total size: ${Math.round(bytesWritten / 1024)}KB`,
        );
        resolve(undefined);
      });
      readable.on('error', reject);
      writeStream.on('error', reject);
    });

    this.logger.log(
      ['verbose', 'noob'],
      `Audiobook saved to: ${outputFilePath}`,
    );
  }

  protected async getTheEntireContent(): Promise<string> {
    interface ChapterData {
      content: string;
      metadata: ReturnType<
        typeof AudiobookCommand.prototype.getChapterMetadata
      >;
    }

    const chapters: ChapterData[] = [];

    for await (const file of getContentsRecursively(this.workingDirectory)) {
      if (this.shouldIncludeChapterFile(file)) {
        const fileContent = await readFile(file);

        const metadata = this.getChapterMetadata(fileContent);
        const content = stripFrontmatter(fileContent);

        chapters.push({
          content,
          metadata,
        });
      }
    }

    chapters.sort((a, b) => a.metadata.index - b.metadata.index);

    return chapters.map((chapter) => chapter.content).join('\n\n');
  }

  protected getChapterMetadata(content: string) {
    const frontmatter = parseFrontmatter(content);
    const validationResult = validateChapterDocumentFrontmatter(frontmatter);
    if (validationResult.success) {
      return validationResult.data;
    }
    //TODO: register a custom error
    throw new Error('Malformed chapter file');
  }
}
