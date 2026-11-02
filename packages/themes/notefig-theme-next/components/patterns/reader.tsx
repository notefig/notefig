import styles from "./reader.module.css";

export type ReaderProps = {
  markdown: {
    html: string;
  };
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
