import type { Markdown } from "contentlayer2/core";
import styles from "./reader.module.css";

export type ReaderProps = {
  markdown: Markdown;
};

export function Reader({ markdown }: ReaderProps) {
  return (
    <div
      className={styles.reader}
      dangerouslySetInnerHTML={{
        __html: markdown.html,
      }}
    />
  );
}
