import { Command } from 'commander';
import { InitCommand } from './init.command';
import { createFileIfNotExists } from '../lib/utils/fs.util';
import { getHostHelper, getSupportedHosts } from '../lib/utils/hosts.util';
import { name } from '../package.json';
import { UnsupportedHostException } from '../exceptions/unsupported-host.exception';
import { HostNotProvidedException } from '../exceptions/host-not-provided.exception';

export class PublishCommand extends InitCommand {
  public load(program: Command) {
    return program
      .command('publish')
      .alias('p')
      .argument('[platform]', 'Platform where the book will be published')
      .description('Publish a production build of the book');
  }

  public async handle(
    command: ReturnType<typeof PublishCommand.prototype.load>,
  ) {
    await super.handle(command);
    const platform = command.args[0];

    // Validate platform and get host helper upfront
    if (!platform) {
      throw new HostNotProvidedException({
        supportedHosts: this.getSupportedHosts(),
      });
    }

    const hostHelper = getHostHelper(platform);
    if (!hostHelper) {
      throw new UnsupportedHostException({
        host: platform,
        supportedHosts: this.getSupportedHosts(),
      });
    }

    // Build the template first
    await super.handle(command);
    const outDir = 'out';
    const buildCommand = `npx ${name} build -o ${outDir}`;

    const [projectMetadata] = await this.extractProjectMetadata();

    await hostHelper.deploy({
      outDir,
      metristsBuildCommand: buildCommand,
      hostOptions: this.getRc((rc) => rc?.hosts?.[platform] || {}),
      projectMetadata,
      logger: this.logger,
    });
  }

  protected async createHostingConfig(
    _hostingPlatform: string,
    hostHelper: any,
    buildCommand: string,
  ) {
    // Only create config file if the host needs one
    if (!hostHelper.configFileName || !hostHelper.getConfigFileContent) {
      return;
    }

    const outDir = this.getRc((rc) => rc?.outDir);
    return await createFileIfNotExists(
      hostHelper.configFileName,
      hostHelper.getConfigFileContent({ outDir, buildCommand }),
    );
  }

  protected getSupportedHosts() {
    const hosts = getSupportedHosts();
    return hosts.join(', ');
  }
}
