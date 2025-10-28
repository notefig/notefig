export interface MockHttpResponsePromise<T> extends Promise<T> {
  asResponse(): Promise<Response>;
}

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
    ): MockHttpResponsePromise<any> => {
      // Create a Web ReadableStream (not Node.js Readable)
      const mockStream = new (globalThis as any).ReadableStream({
        start(controller: any) {
          // Push some mock audio data
          const mockData = new Uint8Array([1, 2, 3, 4, 5]);
          controller.enqueue(mockData);
          controller.close();
        }
      });

      const promise = Promise.resolve(
        mockStream,
      ) as MockHttpResponsePromise<any>;

      promise.asResponse = () => Promise.resolve(new Response());
      return promise;
    },

    stream: (
      _voiceId: string,
      _options: {
        outputFormat?: string;
        text: string;
        modelId?: string;
      },
    ): any => {
      return {};
    },
  };
}

export const ElevenLabsClient = MockElevenLabsClient;
