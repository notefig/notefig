import { Host } from '../host.interface';

export const netlify: Host = {
  configFileName: 'netlify.toml',
  getConfigFileContent: ({ outDir, command }) => `[build]
publish = "${outDir}"
command = "${command}"
`,
};