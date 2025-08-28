import { Host } from '../host.interface';

export const vercel: Host = {
  configFileName: 'vercel.json',
  getConfigFileContent: ({ outDir, command }) =>
    JSON.stringify({
      'buildCommand': command,
      'outputDirectory': outDir,
    }),
};