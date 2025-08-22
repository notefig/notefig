import { BuildCommand } from './build.command';
import { createFileIfNotExists } from '../lib/utils/fs.util';
import { getHostHelper, getSupportedHosts } from '../lib/utils/hosts.util';
import { name } from '../package.json';
import { UnsupportedHostException } from '../exceptions/unsupported-host.exception';
import { HostNotProvidedException } from '../exceptions/host-not-provided.exception';
import { Command } from 'commander';
import { InitCommand } from './init.command';

export class PublishCommand extends InitCommand {
  public load(program: Command) {
    return program
      .command('publish')
      .alias('p')
      .option('-o, --out <path>', 'Output directory for the production build')
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
    const outDir = this.getRc((rc) => rc?.outDir);
    const buildCommand = `npx ${name} build -o ${outDir}`;

    if (hostHelper.requiresBuild) {
      const buildCommand = new BuildCommand();
      buildCommand.setServices(this.services);
      const buildProgram = buildCommand.load(new Command());
      buildProgram.setOptionValue('out', outDir);
      await buildCommand.handle(buildProgram);
    }

    // Then create hosting config and execute side effects independently
    await Promise.all([
      this.createHostingConfig(platform, hostHelper, buildCommand),
      this.executeHostSideEffects(platform, hostHelper, buildCommand),
    ]);
  }

  protected async createHostingConfig(
    hostingPlatform: string,
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

  protected async executeHostSideEffects(
    hostingPlatform: string,
    hostHelper: any,
    buildCommand: string,
  ) {
    if (!hostHelper.sideEffect) {
      return;
    }

    const templateOutputPath = this.getFinalTemplateOutputPath();

    try {
      const rcConfig = this.getRc((rc) => rc);
      await hostHelper.sideEffect(rcConfig, { outDir: templateOutputPath });
    } catch (error) {
      console.error(
        `Error executing ${hostingPlatform} sideeffect:`,
        error.message,
      );
      throw error;
    }
  }
}
