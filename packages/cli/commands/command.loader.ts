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
import { BaseException } from '../exceptions/base.exception';
import { ProjectConfigException } from '../exceptions/project-config.exception';
import type { Command } from 'commander';
import {
  ProjectConfigEnvResolutionError,
  ProjectConfigJsonParseError,
  ProjectConfigSchemaReferenceError,
} from '@metrists/shared';

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
        if (error instanceof BaseException) {
          this.logger.error(`${ERROR_PREFIX} ${error.getMessage()}`);
          process.exit(1);
        }
        if (
          error instanceof ProjectConfigEnvResolutionError ||
          error instanceof ProjectConfigJsonParseError ||
          error instanceof ProjectConfigSchemaReferenceError
        ) {
          const ex = new ProjectConfigException(error.message);
          this.logger.error(`${ERROR_PREFIX} ${ex.getMessage()}`);
          process.exit(1);
        }
        if (error?.name === 'ZodError' && Array.isArray(error?.issues)) {
          const details = error.issues
            .map(
              (issue: any) =>
                `${issue.path.join('.') || '<root>'}: ${issue.message}`,
            )
            .join('; ');
          const ex = new ProjectConfigException(
            `Schema validation failed. ${details}`,
          );
          this.logger.error(`${ERROR_PREFIX} ${ex.getMessage()}`);
          process.exit(1);
        }
        throw error;
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
