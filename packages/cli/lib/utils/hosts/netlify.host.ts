import { Host, HostDeployParams, HostDeployResult } from '../host.interface';
import { writeFileSync } from 'fs';
import { join } from 'path';

export const netlify: Host = {
  async deploy(params: HostDeployParams): Promise<HostDeployResult> {
    const { outDir, metristsBuildCommand } = params;
    
    const configContent = `[build]
publish = "${outDir}"
command = "${metristsBuildCommand}"
`;
    
    const configPath = join(process.cwd(), 'netlify.toml');
    writeFileSync(configPath, configContent);
    
    return {
      createdFiles: ['netlify.toml']
    };
  },
  
  getConfigFilePaths(): string[] {
    return ['netlify.toml'];
  }
};
