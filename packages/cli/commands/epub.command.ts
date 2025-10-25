import { join } from 'path';
import { InitCommand } from './init.command';
import { makeBook, type BookMetadata } from '../lib/epub';
import type { Command } from 'commander';

export class EpubCommand extends InitCommand {
  protected workingDirectory: string;
  protected templatePath: string;

  public load(program: Command) {
    return program
      .command('epub')
      .description('Generate a Epub Documents')
      .option('-o, --out <path>', 'Output file path for the epub build');
  }

  public async handle(command: Command) {
    await super.handle(command);
    const outFileRelative: string = command.opts().out;
    if (!outFileRelative) {
      throw new Error('Output directory is required');
    }
    const extension = outFileRelative.endsWith('.epub') ? '' : '.epub';

    const workingDirectory = process.cwd();
    const metadata = await this.getBookMetadata();

    makeBook({
      ...metadata,
      bookDirectory: workingDirectory,
      ignoredFiles: [this.metaFileName],
      outputPath: join(workingDirectory, outFileRelative + extension),
    });
  }

  protected async getBookMetadata(): Promise<BookMetadata> {
    const [metadata, description] = await this.extractProjectMetadata();
    return {
      author: metadata.author,
      title: metadata.title,
      description: description,
      language: 'en',
      tags: metadata.tags,
      cover_image: join(this.workingDirectory, 'cover.jpg'),
    };
  }
}
