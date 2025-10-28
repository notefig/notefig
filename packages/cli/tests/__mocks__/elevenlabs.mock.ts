export class MockElevenLabsClient {
  constructor(_config: { apiKey: string }) {}

  public textToSpeech = {
    convert: (
      _voiceId: string,
      _options: {
        outputFormat?: string;
        text: string;
        modelId?: string;
      },
    ): Promise<any> => {
      // Create a Web ReadableStream (not Node.js Readable)
      const mockStream = new (globalThis as any).ReadableStream({
        start(controller: any) {
          // Push some mock audio data
          const mockData = new Uint8Array([1, 2, 3, 4, 5]);
          controller.enqueue(mockData);
          controller.close();
        }
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
      // Create a Web ReadableStream for streaming audio
      return new (globalThis as any).ReadableStream({
        start(controller: any) {
          // Push some mock audio data chunks for streaming
          const mockChunk1 = new Uint8Array([1, 2, 3, 4, 5]);
          const mockChunk2 = new Uint8Array([6, 7, 8, 9, 10]);
          const mockChunk3 = new Uint8Array([11, 12, 13, 14, 15]);
          
          controller.enqueue(mockChunk1);
          controller.enqueue(mockChunk2);
          controller.enqueue(mockChunk3);
          controller.close();
        }
      });
    },
  };
}

export const ElevenLabsClient = MockElevenLabsClient;
