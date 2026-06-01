import { EOL } from 'os';
import { createWriteStream } from 'fs';
import { Readable, pipeline } from 'stream';
import { promisify } from 'util';
import { getElevenLabsService } from '../utils/elevenlabs.util';
import { parseFrontmatter, stripFrontmatter } from '../utils/frontmatter.util';
import { languages } from '../utils/transcriptions.util';
import { getContentsRecursively, readFile } from '../utils/fs.util';
import {
  validateChapterDocumentFrontmatter,
  type MetaDocumentFrontmatterInterface,
} from '../utils/content-layer.util';
import type { Logger } from '../utils/logger.util';
import type { ProjectConfigV1Output } from '@metrists/shared';

interface MakeAudiobookParams {
  workingDirectory: string;
  config: ProjectConfigV1Output;
  extractProjectMetadata: () => Promise<
    [MetaDocumentFrontmatterInterface, string]
  >;
  shouldIncludeChapterFile: (path: string) => boolean;
  outputPath: string;
}

export function canMakeAudiobook() {
  return true;
}

export async function makeAudiobook(
  makeAudiobookParams: MakeAudiobookParams,
  logger: Logger,
) {
  const { outputPath, config } = makeAudiobookParams;
  const entireContent = await getTheEntireContent(makeAudiobookParams);

  if (!entireContent.trim()) {
    logger.error('No chapter content found to convert to audiobook');
    process.exit(1);
  }

  logger.log(
    ['verbose', 'noob'],
    `Streaming ${entireContent.length} characters to audiobook...`,
  );

  const elevenLabsService = getElevenLabsService();

  logger.log(
    ['verbose', 'noob'],
    'Initiating streaming connection to ElevenLabs...',
  );
  const audio = await elevenLabsService.streamTextToSpeech(
    entireContent,
    config,
  );

  const writeStream = createWriteStream(outputPath);

  logger.log(['verbose', 'noob'], 'Starting audio stream processing...');
  const readable = Readable.fromWeb(audio);

  let bytesWritten = 0;
  readable.on('data', (chunk) => {
    bytesWritten += chunk.length;
    if (bytesWritten % 10240 === 0) {
      logger.log(
        ['verbose'],
        `Streaming progress: ${Math.round(bytesWritten / 1024)}KB processed`,
      );
    }
  });

  const pipelineAsync = promisify(pipeline);
  await pipelineAsync(readable, writeStream);

  logger.log(
    ['verbose', 'noob'],
    `Stream completed. Total size: ${Math.round(bytesWritten / 1024)}KB`,
  );

  logger.log(['verbose', 'noob'], `Audiobook saved to: ${outputPath}`);
}

async function getTheEntireContent({
  workingDirectory,
  shouldIncludeChapterFile,
  extractProjectMetadata,
  outputPath,
}: MakeAudiobookParams): Promise<string> {
  interface ChapterData {
    content: string;
    metadata: ReturnType<typeof getChapterMetadata>;
  }

  //TODO: read from metadata
  const lang = 'en';
  const transcription = languages[lang];
  const chapters: ChapterData[] = [];

  for await (const file of getContentsRecursively(workingDirectory)) {
    if (shouldIncludeChapterFile(file)) {
      const fileContent = await readFile(file);
      const metadata = getChapterMetadata(fileContent);
      const chapterTranscription = substituteTranscription(
        transcription.chapter,
        metadata,
      );

      const content =
        chapterTranscription + EOL + stripFrontmatter(fileContent);

      chapters.push({
        content,
        metadata,
      });
    }
  }

  chapters.sort((a, b) => a.metadata.index - b.metadata.index);

  let metaTranscription = '';
  const [metadata] = await extractProjectMetadata();
  if (metadata) {
    metaTranscription = substituteTranscription(
      transcription.metadata,
      metadata as Record<string, string>,
    );
    metaTranscription += '\n\n';
  }

  return (
    metaTranscription + chapters.map((chapter) => chapter.content).join('\n\n')
  );
}

function getChapterMetadata(content: string) {
  const frontmatter = parseFrontmatter(content);
  const validationResult = validateChapterDocumentFrontmatter(frontmatter);
  if (validationResult.success) {
    if (validationResult.data.index !== undefined) {
      validationResult.data.index++;
    }
    return validationResult.data;
  }
  //TODO: register a custom error
  throw new Error('Malformed chapter file');
}

function substituteTranscription(
  content: string,
  substitutions: Record<string, string | number>,
) {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return substitutions[key]?.toString() || match;
  });
}
