import { Host, HostDeployParams, HostDeployResult } from '../host.interface';
import { writeFileSync } from 'fs';
import { join } from 'path';

export const vercel: Host = {
  async deploy(params: HostDeployParams): Promise<HostDeployResult> {
    const { outDir, metristsBuildCommand } = params;
    
    const configContent = JSON.stringify({
      'buildCommand': metristsBuildCommand,
      'outputDirectory': outDir,
    });
    
    const configPath = join(process.cwd(), 'vercel.json');
    writeFileSync(configPath, configContent);
    
    return {
      createdFiles: ['vercel.json']
    };
  },
  
  getConfigFilePaths(): string[] {
    return ['vercel.json'];
  }
};
