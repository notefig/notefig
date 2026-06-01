import { config } from 'dotenv';
import { join } from 'path';
import {
  parseProjectConfigWithEnv,
  PROJECT_CONFIG_FILE_NAME,
  ProjectConfigSchemaReferenceError,
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
  if (!rcContent) {
    throw new ProjectConfigSchemaReferenceError(
      `No ${RC_FILE_NAME} file found in ${join(...basePath)}`,
    );
  }

  const data = parseProjectConfigWithEnv(rcContent, process.env);

  function getConfig<TResult>(
    callback: GetRcFieldValue<TResult>,
    defaultValue?: TResult,
  ): TResult {
    return callback(data) ?? defaultValue;
  }
  return getConfig;
}
