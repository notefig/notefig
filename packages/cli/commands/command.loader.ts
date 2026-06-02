import * as chalk from 'chalk';
import { ERROR_PREFIX } from '../lib/ui';
import { AbstractCommand } from './abstract.command';
import { WatchCommand } from './watch.command';
import { InitCommand } from './init.command';
import { PublishCommand } from './publish.command';
import { BuildCommand } from './build.command';
import { PruneCommand } from './prune.command';
import { EpubCommand } from './epub.command';
import { AudiobookCommand } from './audiobook.command';
import {
  ConsoleLogger,
  type Logger,
  type LogTypes,
} from '../lib/utils/logger.util';
import { ProjectConfigException } from '../exceptions/project-config.exception';
import type { Command } from 'commander';

export class CommandLoader {
  protected static logger: Logger;
  public static load(program: Command): void {
    this.logger = new ConsoleLogger(
      this.getLogLevelsFromCommanderOptions(program),
    );
    program.showSuggestionAfterError();
    this.loadCommandAndAction(new WatchCommand(), program);
    this.loadCommandAndAction(new InitCommand(), program);
    this.loadCommandAndAction(new PublishCommand(), program);
    this.loadCommandAndAction(new BuildCommand(), program);
    this.loadCommandAndAction(new PruneCommand(), program);
    this.loadCommandAndAction(new EpubCommand(), program);
    this.loadCommandAndAction(new AudiobookCommand(), program);
    this.handleInvalidCommand(program);
  }

  private static handleInvalidCommand(program: Command) {
    program.on('command:*', () => {
      this.logger.error(
        `\n${ERROR_PREFIX} Invalid command: ${chalk.red('%s')}`,
        program.args.join(' '),
      );
      this.logger.info(
        `See ${chalk.red('--help')} for a list of available commands.\n`,
      );
      process.exit(1);
    });
  }

  private static formatZodIssues(issues: any[]): string {
    return issues
      .map((issue: any) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
  }

  private static resolveZodError(error: any): string | null {
    if (!Array.isArray(error?.issues)) {
      return null;
    }
    return new ProjectConfigException(
      `Schema validation failed. ${this.formatZodIssues(error.issues)}`,
    ).getMessage();
  }

  private static resolveErrorMessage(error: any): string | null {
    if (!error) {
      return null;
    }
    if (typeof error.getMessage === 'function') {
      return error.getMessage();
    }
    const name = error.name;
    if (typeof name !== 'string') {
      return null;
    }
    if (name.startsWith('ProjectConfig')) {
      return new ProjectConfigException(error.message).getMessage();
    }
    if (name === 'ZodError') {
      return this.resolveZodError(error);
    }
    return null;
  }

  private static handleActionError(error: any): never {
    const message = this.resolveErrorMessage(error);
    if (message) {
      this.logger.error(`${ERROR_PREFIX} ${message}`);
      process.exit(1);
    }
    throw error;
  }

  protected static loadCommandAndAction(
    command: AbstractCommand,
    program: Command,
  ) {
    const commanderCommand = command.load(program);
    commanderCommand.action(async () => {
      try {
        const commandLogger = new ConsoleLogger(
          this.getLogLevelsFromCommanderOptions(commanderCommand),
        );
        const services = {
          logger: commandLogger,
        };
        command.setServices(services);
        return await command.handle(commanderCommand);
      } catch (error: any) {
        this.handleActionError(error);
      }
    });
    return commanderCommand;
  }

  protected static getLogLevelsFromCommanderOptions(
    commanderCommand: Command,
  ): LogTypes[] | null {
    const logLevelOptions: LogTypes[] = ['verbose', 'noob'];

    const options = commanderCommand.optsWithGlobals();
    const logLevel = logLevelOptions.filter((option) => options[option]);
    if (logLevel) {
      return logLevel;
    }
  }
}
