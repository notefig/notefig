export interface ITranscription {
  metadata: string;
  chapter: string;
}

export const languages: Record<string, ITranscription> = {
  en: {
    metadata: `{{title}} by {{author}} \n`,
    chapter: `Chapter {{index}} {{title}}. \n`,
  },
};
