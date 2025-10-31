import { type ClassValue, clsx } from "clsx";
import { ChapterNavigationProps } from "@/components/patterns/chapter-navigation";
import { readdir } from "fs/promises";
import { join } from "path";
import { twMerge } from "tailwind-merge";
import { coverPath, acceptedCoverFormats, defaultCoverPath } from "@/constants";
import type { Meta, Chapter } from ".contentlayer/generated";
import type { ToastActionElement, ToastProps } from "@/components/ui/toast";
import * as React from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ChapterLike = Pick<Chapter, "slug" | "title" | "index">;

export type ChapterNavigation = [
  ChapterLike | undefined,
  ChapterLike | undefined,
];

export function getChapterNavigation(
  currentChapter: ChapterLike | undefined,
  chapters: ChapterLike[],
): ChapterNavigationProps["navigation"] {
  const slug = currentChapter?.slug;
  const index = slug ? getSlugChapterIndex(slug, chapters) : -1;
  return [chapters[index - 1] ?? null, chapters[index + 1] ?? null];
}

export function getSlugChapterIndex(
  slug: string,
  chapters: ChapterLike[],
): number {
  return chapters.findIndex((chapter: ChapterLike) => chapter.slug === slug);
}

/**
 * Provide a condition and if that condition is falsey, this throws an error
 * with the given message.
 *
 * inspired by invariant from 'tiny-invariant' except will still include the
 * message in production.
 *
 * @example
 * invariant(typeof value === 'string', `value must be a string`)
 *
 * @param condition The condition to check
 * @param message The message to throw (or a callback to generate the message)
 * @param responseInit Additional response init options if a response is thrown
 *
 * @throws {Error} if condition is falsey
 */
export function invariant(
  condition: any,
  message: string | (() => string),
): asserts condition {
  if (!condition) {
    throw new Error(typeof message === "function" ? message() : message);
  }
}

/**
 * Provide a condition and if that condition is falsey, this throws a 400
 * Response with the given message.
 *
 * inspired by invariant from 'tiny-invariant'
 *
 * @example
 * invariantResponse(typeof value === 'string', `value must be a string`)
 *
 * @param condition The condition to check
 * @param message The message to throw (or a callback to generate the message)
 * @param responseInit Additional response init options if a response is thrown
 *
 * @throws {Response} if condition is falsey
 */
export function invariantResponse(
  condition: any,
  message: string | (() => string),
  responseInit?: ResponseInit,
): asserts condition {
  if (!condition) {
    throw new Response(typeof message === "function" ? message() : message, {
      status: 400,
      ...responseInit,
    });
  }
}

export interface ShareData {
  title: string;
  url: string;
  text: string;
}

export async function shareOrCopy(
  { title, url, text }: ShareData,
  onSuccess: (shareData: ShareData, method: "share" | "clipboard") => void,
  onFail?: (shareData?: ShareData) => void,
) {
  if (navigator.share) {
    await navigator.share({
      title: title,
      url: url,
      text: text,
    });
    onSuccess({ title, url, text }, "share");
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    onSuccess({ title, url, text }, "clipboard");
  } else if (onFail) {
    onFail({ title, url, text });
  }
}

export function shareMetaCurry(
  toast: ReturnType<typeof useToast>["toast"],
  meta: Meta,
) {
  return async () => {
    await shareOrCopy(
      {
        title: meta.title,
        url: window.location.href,
        text: meta.body.raw,
      },
      (_, method: "clipboard" | "share") => {
        if (method === "clipboard") {
          toast({
            title: "Link Copied",
          });
        }
      },
      (_) => {
        toast({
          title: `Could not share`,
          description: `It seems like your browser does not support sharing or copying links.`,
        });
      },
    );
  };
}

export function getRequestUrl(host: string | URL, route?: string) {
  const hostString = typeof host === "string" ? host : host.toString();
  const hostStringWithSchema = addSchemaToHost(hostString);

  const url = new URL(route ?? "", hostStringWithSchema);

  return url.toString();
}

function addSchemaToHost(host: string) {
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return host;
  }
  return `https://${host}`;
}

export function useShare(meta: Parameters<typeof shareMetaCurry>[1]) {
  const { toast } = useToast();
  return shareMetaCurry(toast, meta);
}

const TOAST_LIMIT = 1;
const TOAST_REMOVE_DELAY = 1000000;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const;

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type ActionType = typeof actionTypes;

type Action =
  | {
      type: ActionType["ADD_TOAST"];
      toast: ToasterToast;
    }
  | {
      type: ActionType["UPDATE_TOAST"];
      toast: Partial<ToasterToast>;
    }
  | {
      type: ActionType["DISMISS_TOAST"];
      toastId?: ToasterToast["id"];
    }
  | {
      type: ActionType["REMOVE_TOAST"];
      toastId?: ToasterToast["id"];
    };

interface State {
  toasts: ToasterToast[];
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: "REMOVE_TOAST",
      toastId: toastId,
    });
  }, TOAST_REMOVE_DELAY);

  toastTimeouts.set(toastId, timeout);
};

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST":
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t,
        ),
      };

    case "DISMISS_TOAST": {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t,
        ),
      };
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners: Array<(state: State) => void> = [];

let memoryState: State = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

type Toast = Omit<ToasterToast, "id">;

function toast({ ...props }: Toast) {
  const id = genId();

  const update = (props: ToasterToast) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    });
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open: any) => {
        if (!open) dismiss();
      },
    },
  });

  return {
    id: id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, [state]);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}

export { useToast, toast };

export async function getCoverPath() {
  const files = await readdir(join(process.cwd(), "public"));
  const coverFile = files.find((file) => {
    const fileNameWithoutPath = file.split("/").pop();
    if (!fileNameWithoutPath) return null;
    const fileNameWithoutExtension = fileNameWithoutPath.split(".").shift();
    const fileExtension = fileNameWithoutPath.split(".").pop();
    if (!fileExtension) return null;
    return (
      fileNameWithoutExtension === coverPath &&
      acceptedCoverFormats.includes(fileExtension)
    );
  });
  return coverFile ?? defaultCoverPath;
}

export function getGeneralMetadata(meta: Meta) {
  return {
    title: meta.title,
    description: meta.body.raw.slice(0, 160), //TODO: strip markdown
  };
}

export function getChapterMetadata(meta: Meta, chapter: Chapter) {
  return {
    title: `${meta.title} - ${chapter.title}`,
    description: meta.body.raw.slice(0, 160), //TODO: strip markdown
  };
}

export async function getEpubDownloadLink(): Promise<string | null> {
  return "/book.epub";
}

export async function getAudiobookDownloadLink(): Promise<string | null> {
  return "/book.mp3";
}
