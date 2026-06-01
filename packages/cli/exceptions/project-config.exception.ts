import { BaseException } from './base.exception';

export class ProjectConfigException extends BaseException {
  public override MESSAGE_TITLE = 'PROJECT_CONFIG_ERROR' as const;

  constructor(message: string) {
    super({ error: message });
  }
}
