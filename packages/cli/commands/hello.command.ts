import { AbstractCommand } from './abstract.command';
import { BANNER } from '../lib/ui';
import { EMOJIS } from '../lib/ui/emojis';
import type { Command } from 'commander';

export class HelloCommand extends AbstractCommand {
  public load(program: Command) {
    return program
      .command('hello')
      .alias('hi')
      .description('Greet the user and display information about Metrists');
  }

  public async handle(_command: Command) {
    this.logger.info(BANNER);
    this.logger.info(
      `${EMOJIS.RAISED_HANDS} Welcome to Metrists! ${EMOJIS.RAISED_HANDS}`,
    );
    this.logger.info('');
    this.logger.info(
      'Metrists is a Continuous Deployment pipeline for your books.',
    );
    this.logger.info(
      'It makes publishing books an incremental, quick and automated process.',
    );
    this.logger.info('');
    this.logger.info('Get started:');
    this.logger.info('  1. Run `metrists init` to initialize a new project');
    this.logger.info(
      '  2. Run `metrists watch --noob` to start live development',
    );
    this.logger.info('  3. Run `metrists publish` to publish your book');
    this.logger.info('');
    this.logger.info(
      `${EMOJIS.ROCKET} Learn more at https://metrists.com/docs`,
    );
  }
}
