/** Screenshots sent with feedback: checked, then uploaded to Linear. */
import type { UploadFile } from "./linear.ts";

const MAX_ATTACHMENTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z0-9]{1,16}$/;

/** Each accepted type, and its signature at the start of the file. */
const TYPES: Record<string, { ext: string; matches: (bytes: Uint8Array) => boolean }> = {
  "image/png": { ext: "png", matches: (b) => startsWith(b, 0, [0x89, 0x50, 0x4e, 0x47]) },
  "image/jpeg": { ext: "jpg", matches: (b) => startsWith(b, 0, [0xff, 0xd8, 0xff]) },
  "image/webp": {
    ext: "webp",
    matches: (b) => startsWith(b, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, 8, [0x57, 0x45, 0x42, 0x50]),
  },
};

export interface Attachment {
  id: string;
  type: string;
  bytes: Uint8Array;
}

/**
 * The screenshots, or null when any is wrong: too many, an id that isn't
 * one, a type not accepted, bytes that aren't that type, or too large.
 */
export async function parseAttachments(files: ReadonlyMap<string, File>): Promise<Attachment[] | null> {
  if (files.size > MAX_ATTACHMENTS) return null;
  const attachments: Attachment[] = [];
  for (const [id, file] of files) {
    const type = TYPES[file.type];
    if (!ID.test(id) || !type || file.size > MAX_BYTES) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!type.matches(bytes)) return null;
    attachments.push({ id, type: file.type, bytes });
  }
  return attachments;
}

export interface Screenshot {
  label: string;
  url: string;
}

const PLACEHOLDER = /!\[[^\]]*\]\(attachment:([a-z0-9]{1,16})\)/g;

/**
 * Uploads each screenshot the message shows, in the order it shows them,
 * and gives back the message with each one as a "[Screenshot N]" marker
 * (no link: the message is public) and the uploaded screenshots. A
 * placeholder with no file, and a file the message doesn't show, are left
 * out.
 */
export async function uploadScreenshots(
  message: string,
  attachments: readonly Attachment[],
  uploadFile: UploadFile,
): Promise<{ message: string; screenshots: Screenshot[] }> {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const labels = new Map<string, string>();
  const screenshots: Screenshot[] = [];
  for (const [, id] of message.matchAll(PLACEHOLDER)) {
    const attachment = byId.get(id);
    if (!attachment || labels.has(id)) continue;
    const label = `Screenshot ${labels.size + 1}`;
    labels.set(id, label);
    const { type, bytes } = attachment;
    const filename = `screenshot-${labels.size}.${TYPES[type].ext}`;
    screenshots.push({ label, url: await uploadFile({ bytes, type, filename }) });
  }
  return {
    message: message.replace(PLACEHOLDER, (_, id: string) => {
      const label = labels.get(id);
      return label ? `*[${label}]*` : "";
    }),
    screenshots,
  };
}

function startsWith(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}
