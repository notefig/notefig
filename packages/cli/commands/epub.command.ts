import { join } from 'path';
import { InitCommand } from './init.command';
import { makeBook, type BookMetadata } from '../lib/epub';
import type { Command } from 'commander';

export class EpubCommand extends InitCommand {
  protected workingDirectory: string;
  protected templatePath: string;

  public load(program: Command) {
    return program.command('epub').description('Generate a Epub Documents');
  }

  public async handle(command: Command) {
    await super.handle(command);

    const workingDirectory = process.cwd();
    const metadata = await this.getBookMetadata();

    console.log(metadata);

    makeBook({ ...metadata, bookDirectory: workingDirectory });
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
      // verbose: true,
      // bookDirectory: join(__dirname, 'sample-book'),
    };
  }
}
