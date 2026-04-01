import { readFileSync } from 'fs';
import { join } from 'path';

export class MockElevenLabsClient {
  constructor(_config: { apiKey: string }) {
    // Mock constructor - no initialization needed
  }

  private getAudioFileData(): Uint8Array {
    const audioFilePath = join(
      __dirname,
      '..',
      '..',
      '..',
      'assets',
      'book.mp3',
    );
    const audioBuffer = readFileSync(audioFilePath);
    return new Uint8Array(audioBuffer);
  }

  public textToSpeech = {
    convert: (
      _voiceId: string,
      _options: {
        outputFormat?: string;
        text: string;
        modelId?: string;
      },
    ): Promise<any> => {
      console.log('Generating audio file for ', _options.text);
      const audioData = this.getAudioFileData();
      const mockStream = new (globalThis as any).ReadableStream({
        start(controller: any) {
          controller.enqueue(audioData);
          controller.close();
        },
      });

      return Promise.resolve(mockStream);
    },

    stream: (
      _voiceId: string,
      _options: {
        outputFormat?: string;
        text: string;
        modelId?: string;
      },
    ): any => {
      console.log('Generating audio file for ', _options.text);
      const audioData = this.getAudioFileData();
      const chunkSize = Math.ceil(audioData.length / 3);

      return new (globalThis as any).ReadableStream({
        start(controller: any) {
          for (let i = 0; i < audioData.length; i += chunkSize) {
            const chunk = audioData.slice(i, i + chunkSize);
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    },
  };
}

export const ElevenLabsClient = MockElevenLabsClient;
