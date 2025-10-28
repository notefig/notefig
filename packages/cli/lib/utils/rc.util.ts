import { config } from 'dotenv';
import { join } from 'path';
import { readFileInJsonIfExists } from './fs.util';
import type { hostHelpers } from './hosts.util';

type ISecretValue = `$${string}`;

export interface IRcFileComplete {
  outDir: string;
  template: {
    name: string;
  };
  hosts?: Partial<Record<keyof typeof hostHelpers, any>>;
  elevenLabs?: {
    apiKey: string | Omit<string, ISecretValue>;
    voiceId: string | Omit<string, ISecretValue>;
  };
}

export type IRcFile = Partial<IRcFileComplete>;

export const RC_FILE_NAME = '.metristsrc';

export const DEFAULT_RC_FILE: IRcFileComplete = {
  outDir: '.metrists',
  template: {
    name: 'metrists-theme-next',
  },
};

export async function readRcFile(...basePath: string[]) {
  return readFileInJsonIfExists<IRcFile>(...basePath, RC_FILE_NAME);
}
export type GetFieldValue<TData, TResult> = (data: TData) => TResult;

export type GetRcFieldValue<TData> = GetFieldValue<IRcFile, TData>;

//TODO: Make sure this gets called only once per execution
export async function getConfigGetter(...basePath: string[]) {
  config({
    'path': join(process.cwd(), '.env'),
  });
  const data = await readRcFile(...basePath);

  function getConfig<TResult>(
    callback: GetRcFieldValue<TResult>,
    defaultValue?: TResult,
  ): TResult {
    return callback(data) ?? defaultValue ?? callback(DEFAULT_RC_FILE);
  }
  return getConfig;
}
