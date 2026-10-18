/**
 * Screenshots in feedback. A pasted or dropped image sits in the draft as
 * an object URL (`blob:`) the editor can show; on send, each one the
 * message still shows is shrunk, encoded, and sent as a file beside the
 * markdown, which refers to it as `attachment:<id>`. The Worker uploads
 * them to Linear and puts the real links in.
 */

/** What the Worker takes per message. */
export const MAX_IMAGES = 3;
/** The longest edge an image is sent at. */
const MAX_EDGE = 1600;
const QUALITY = 0.85;

export interface Attachment {
  id: string;
  image: Blob;
}

/** Turns a pasted image into what's sent: smaller, and compressed. */
export type EncodeImage = (image: Blob) => Promise<Blob>;

const IMAGE = /!\[([^\]]*)\]\((blob:[^)\s]+|data:image\/[a-z+]+;base64,[^)\s]+)\)/g;

/**
 * The message's length as the Worker counts it: an image by the
 * placeholder it's sent as, not by the bytes a data URL would carry.
 */
export function messageLength(markdown: string): number {
  return markdown.replace(IMAGE, (_, alt: string) => `![${alt}](attachment:img0)`)
    .length;
}

/**
 * The message as sent, and its attachments: the first `MAX_IMAGES` images
 * it shows, each encoded. An image past the limit, or a `blob:` URL the
 * draft no longer holds, is dropped from the message.
 */
export async function collectImages(
  message: string,
  draftImages: ReadonlyMap<string, Blob>,
  encode: EncodeImage,
): Promise<{ message: string; attachments: Attachment[] }> {
  const ids = new Map<string, string>();
  for (const [, , src] of message.matchAll(IMAGE)) {
    const known = draftImages.has(src) || src.startsWith("data:");
    if (known && !ids.has(src) && ids.size < MAX_IMAGES) {
      ids.set(src, `img${ids.size + 1}`);
    }
  }
  const attachments = await Promise.all(
    [...ids].map(async ([src, id]) => {
      const image = draftImages.get(src) ?? dataUrlToBlob(src);
      return { id, image: await encode(image) };
    }),
  );
  return {
    message: message.replace(IMAGE, (_, alt: string, src: string) => {
      const id = ids.get(src);
      return id ? `![${alt}](attachment:${id})` : "";
    }),
    attachments,
  };
}

/**
 * The browser's encoder: scaled to fit `MAX_EDGE`, as WebP, or as JPEG
 * where the webview can't write WebP (WebKit hands back PNG instead).
 */
export async function encodeForUpload(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const webp = await canvasBlob(canvas, "image/webp");
  return webp.type === "image/webp" ? webp : canvasBlob(canvas, "image/jpeg");
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))),
      type,
      QUALITY,
    ),
  );
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(",", 2);
  const type = header.slice("data:".length).split(";")[0];
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type });
}
