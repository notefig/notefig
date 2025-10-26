import Head from "next/head";
import { Header } from "@/components/patterns/header";
import { Sidebar } from "@/components/patterns/sidebar";
import { allMeta, allChapters } from "contentlayer/generated";
import {
  getChapterNavigation,
  getCoverPath,
  getGeneralMetadata,
  useShare,
} from "@/lib/utils";
import { BookOverview } from "@/components/patterns/book-overview";
import { Reader } from "@/components/patterns/reader";
import { Share } from "lucide-react";

export async function getStaticProps() {
  const navigation = getChapterNavigation(undefined, allChapters);
  return {
    props: {
      meta: allMeta[0],
      chapters: allChapters,
      navigation,
      coverPath: await getCoverPath(),
      metadata: getGeneralMetadata(allMeta[0]),
    },
  };
}

export default function Home({
  meta,
  chapters,
  navigation,
  coverPath,
  metadata,
}: Awaited<ReturnType<typeof getStaticProps>>["props"]) {
  const shareMeta = useShare(meta);
  const firstChapter = chapters[0];

  return (
    <>
      <Head>
        <title>{metadata.title}</title>
        <meta name="description" content={metadata.description} />
      </Head>
      <Header meta={meta} coverPath={coverPath}>
        <Sidebar meta={meta} chapters={chapters} navigation={navigation}>
          <BookOverview
            title={meta.title}
            cover={coverPath}
            authors={meta.authors}
            actions={[
              ...(firstChapter
                ? [
                  {
                    label: "Start Reading",
                    action: `/${firstChapter.slug}`,
                    buttonProps: {},
                  },
                ]
                : []),
              {
                label: "Download Epub",
                action: "/book.epub",
                buttonProps: { variant: "secondary" },
              },
              {
                label: <Share size={16} />,
                action: shareMeta,
                buttonProps: { variant: "secondary", className: "px-3" },
              },
            ]}
            twoToneImageProps={{
              imageContainerClassName: "max-h-[300px]",
            }}
          />
          <div className="pt-4">
            <Reader markdown={meta.body} />
          </div>
        </Sidebar>
      </Header>
    </>
  );
}
