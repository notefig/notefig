import { BaseException } from './base.exception';

export class ElevenLabsException extends BaseException {
  MESSAGE_TITLE = 'ELEVENLABS_API_ERROR' as const;

  constructor(message: string, statusCode?: number) {
    super({ 
      message: statusCode ? `${message} (Status: ${statusCode})` : message 
    });
  }
}