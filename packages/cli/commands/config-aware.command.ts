import { AbstractCommand } from './abstract.command';
import {
  getConfigGetter as getRcConfigGetter,
  type GetRcFieldValue,
} from '../lib/utils/rc.util';
import {
  getConfigGetter as getTemplateConfigGetter,
  type GetTemplateConfigFieldValue,
} from '../lib/utils/template-config.util';
import { PROJECT_CONFIG_FILE_NAME } from '@metrists/shared';

export abstract class ConfigAwareCommand extends AbstractCommand {
  protected _getConfig: Awaited<ReturnType<typeof getRcConfigGetter>>;

  protected _getTemplateConfig: Awaited<
    ReturnType<typeof getTemplateConfigGetter>
  >;

  protected async loadRcConfig() {
    if (this.isRcConfigLoaded()) return;
    this._getConfig = await getRcConfigGetter(process.cwd());
  }

  protected isRcConfigLoaded() {
    return !!this._getConfig;
  }

  protected getRc<TData>(cb: GetRcFieldValue<TData>, defaultValue?: TData) {
    if (!this._getConfig) {
      throw new Error(
        'Config is not loaded. Please call loadConfig() before getConfig()',
      );
    }

    return this._getConfig(cb, defaultValue);
  }

  protected async loadTemplateConfig() {
    if (!this.isRcConfigLoaded()) {
      throw new Error(
        'Rc Config is not loaded. Template Config cannot be loaded without Rc Config.',
      );
    }
    if (this.isTemplateConfigLoaded()) return;
    this._getTemplateConfig = await getTemplateConfigGetter(
      process.cwd(),
      this.getRc((rc) => rc?.outputs?.web?.outDir),
    );
  }

  protected isTemplateConfigLoaded() {
    return !!this._getTemplateConfig;
  }

  protected getTemplateConfig<TData>(
    cb: GetTemplateConfigFieldValue<TData>,
    defaultValue?: TData,
  ) {
    if (!this._getTemplateConfig) {
      throw new Error(
        'Template Config is not loaded. Please call loadConfig() before getConfig()',
      );
    }

    return this._getTemplateConfig(cb, defaultValue);
  }

  protected getHostConfig<TData>(
    hostName: string,
    cb: (hostConfig: any) => TData,
    defaultValue?: TData,
  ): TData {
    if (!this._getConfig) {
      throw new Error(
        'Config is not loaded. Please call loadRcConfig() before getHostConfig()',
      );
    }

    const hostConfig = this.getRc((rc) =>
      rc?.outputs?.web?.deploy?.provider === hostName
        ? rc?.outputs?.web?.deploy?.options
        : undefined,
    );
    if (!hostConfig && defaultValue === undefined) {
      throw new Error(
        `Host configuration for '${hostName}' not found in ${PROJECT_CONFIG_FILE_NAME} file`,
      );
    }

    return hostConfig ? cb(hostConfig) : defaultValue!;
  }
}
