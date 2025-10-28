import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { MockElevenLabsClient as ElevenLabsClientMock } from '../../tests/__mocks__/elevenlabs.mock';
import { ElevenLabsException } from '../../exceptions/elevenlabs.exception';
import type { ReadableStream } from 'stream/web';

class ElevenLabsService {
  private static instance: ElevenLabsService;
  private client: ElevenLabsClient | ElevenLabsClientMock;

  private constructor() {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      throw new ElevenLabsException(
        'ELEVENLABS_API_KEY environment variable is required',
      );
    }

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

  public static getInstance(): ElevenLabsService {
    if (!ElevenLabsService.instance) {
      ElevenLabsService.instance = new ElevenLabsService();
    }
    return ElevenLabsService.instance;
  }

  public async convertTextToSpeech(
    text: string,
    voiceId?: Parameters<typeof this.client.textToSpeech.convert>[0],
    options?: {
      outputFormat?: any;
      modelId?: string;
    },
  ): Promise<any> {
    const finalVoiceId = voiceId || process.env.ELEVENLABS_VOICE_ID;

    if (!finalVoiceId) {
      throw new ElevenLabsException(
        'ELEVENLABS_VOICE_ID environment variable is required or voiceId must be provided',
      );
    }

    try {
      return await this.client.textToSpeech.convert(finalVoiceId, {
        outputFormat: options?.outputFormat || 'mp3_44100_128',
        text,
        modelId: options?.modelId || 'eleven_multilingual_v2',
      });
    } catch (error: any) {
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
  }

  public async streamTextToSpeech(
    text: string,
    voiceId?: string,
    options?: {
      outputFormat?: any;
      modelId?: string;
    },
  ): Promise<ReadableStream<Uint8Array>> {
    const finalVoiceId = voiceId || process.env.ELEVENLABS_VOICE_ID;

    if (!finalVoiceId) {
      throw new ElevenLabsException(
        'ELEVENLABS_VOICE_ID environment variable is required or voiceId must be provided',
      );
    }

    try {
      return await this.client.textToSpeech.stream(finalVoiceId, {
        outputFormat: (options?.outputFormat || 'mp3_44100_128') as any,
        text,
        modelId: options?.modelId || 'eleven_multilingual_v2',
      });
    } catch (error: any) {
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
  }
}

export const getElevenLabsService = () => ElevenLabsService.getInstance();
