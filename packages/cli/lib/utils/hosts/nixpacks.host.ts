import { Host, HostDeployParams, HostDeployResult } from '../host.interface';
import { writeFileSync } from 'fs';
import { join } from 'path';

export const nixpacks: Host = {
  async deploy(params: HostDeployParams): Promise<HostDeployResult> {
    const { outDir, metristsBuildCommand } = params;

    const configContent = `providers = ['node']

[phases.build]
cmds = ['${metristsBuildCommand}']

[start]
cmd = 'cd ${outDir} && npx serve -s'
`;

    const configPath = join(process.cwd(), 'nixpacks.toml');
    writeFileSync(configPath, configContent);

    return {
      createdFiles: ['nixpacks.toml'],
    };
  },

  getConfigFilePaths(): string[] {
    return ['nixpacks.toml'];
  },
};
