import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { MockElevenLabsClient as ElevenLabsClientMock } from '../../tests/__mocks__/elevenlabs.mock';
import { ElevenLabsException } from '../../exceptions/elevenlabs.exception';
import type { ReadableStream } from 'stream/web';
import type { ProjectConfigV1Output } from '@metrists/shared';

class ElevenLabsService {
  private client: ElevenLabsClient | ElevenLabsClientMock;

  constructor(apiKey: string) {
    if (process.env.TEST) {
      this.client = new ElevenLabsClientMock({
        apiKey,
      });
    } else {
      this.client = new ElevenLabsClient({
        apiKey,
      });
    }
  }

  private getVoiceId(
    config?: ProjectConfigV1Output,
    voiceId?: string,
  ): string {
    return (
      voiceId ||
      config?.outputs?.audiobook?.voiceId ||
      process.env.ELEVENLABS_VOICE_ID ||
      'pqHfZKP75CvOlQylNhV4'
    );
  }

  private getModelId(config?: ProjectConfigV1Output, options?: { modelId?: string }): string {
    return (
      options?.modelId ||
      config?.outputs?.audiobook?.modelId ||
      'eleven_multilingual_v2'
    );
  }

  private handleElevenLabsError(error: any): never {
    if (error.statusCode && error.body?.detail?.message) {
      throw new ElevenLabsException(
        error.body.detail.message,
        error.statusCode,
      );
    }
    throw new ElevenLabsException(
      error.message || 'Unknown ElevenLabs API error',
    );
  }

  public async convertTextToSpeech(
    text: string,
    config?: ProjectConfigV1Output,
    voiceId?: Parameters<typeof this.client.textToSpeech.convert>[0],
    options?: {
      outputFormat?: any;
      modelId?: string;
    },
  ) {
    try {
      return await this.client.textToSpeech.convert(
        this.getVoiceId(config, voiceId as string),
        {
          outputFormat: options?.outputFormat || 'mp3_44100_128',
          text,
          modelId: this.getModelId(config, options),
        },
      );
    } catch (error: any) {
      this.handleElevenLabsError(error);
    }
  }

  public async streamTextToSpeech(
    text: string,
    config?: ProjectConfigV1Output,
    voiceId?: string,
    options?: {
      outputFormat?: any;
      modelId?: string;
    },
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      return await this.client.textToSpeech.stream(
        this.getVoiceId(config, voiceId),
        {
          outputFormat: (options?.outputFormat ||
            config?.outputs?.audiobook?.format ||
            'mp3_44100_128') as any,
          text,
          modelId: this.getModelId(config, options),
        },
      );
    } catch (error: any) {
      this.handleElevenLabsError(error);
    }
  }
}

export function getElevenLabsService(apiKey: string): ElevenLabsService {
  return new ElevenLabsService(apiKey);
}
