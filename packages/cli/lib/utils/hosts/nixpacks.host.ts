import { Host } from '../host.interface';

export const nixpacks: Host = {
  configFileName: 'nixpacks.toml',
  getConfigFileContent: ({ outDir, command }) => `providers = ['node']

[phases.build]
cmds = ['${command}']

[start]
cmd = 'cd ${outDir} && npx serve -s'
`,
};