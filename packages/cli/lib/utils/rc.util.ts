import { config } from 'dotenv';
import { join } from 'path';
import {
  parseProjectConfigWithEnv,
  createDefaultProjectConfigV1,
  PROJECT_CONFIG_FILE_NAME,
  type ProjectConfigV1Output,
} from '@metrists/shared';
import { readFileIfExists } from './fs.util';

export const RC_FILE_NAME = PROJECT_CONFIG_FILE_NAME;

export type GetRcFieldValue<TData> = (data: ProjectConfigV1Output) => TData;

//TODO: Make sure this gets called only once per execution
export async function getConfigGetter(...basePath: string[]) {
  config({
    'path': join(process.cwd(), '.env'),
  });
  const rcContent = await readFileIfExists<string>(...basePath, RC_FILE_NAME);

  let data: ProjectConfigV1Output;
  if (rcContent) {
    data = parseProjectConfigWithEnv(rcContent, process.env);
  } else {
    data = createDefaultProjectConfigV1();
  }

  function getConfig<TResult>(
    callback: GetRcFieldValue<TResult>,
    defaultValue?: TResult,
  ): TResult {
    return callback(data) ?? defaultValue;
  }
  return getConfig;
}
