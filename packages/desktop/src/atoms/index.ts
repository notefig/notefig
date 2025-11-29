import { atom } from "jotai";

export const editorTextAtom = atom("");
export const fileUrlAtom = atom("");

// Export file system atoms
export * from "./fileSystem";
