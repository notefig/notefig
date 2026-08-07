import Head from "next/head";
import { Header } from "@/components/patterns/header";
import { Sidebar } from "@/components/patterns/sidebar";
import { allMeta, allChapters } from "contentlayer/generated";
import {
  getChapterNavigation,
  getCoverPath,
  getGeneralMetadata,
  getEpubDownloadLink,
  getAudiobookDownloadLink,
  useShare,
} from "@/lib/utils";
import { BookOverview } from "@/components/patterns/book-overview";
import { Reader } from "@/components/patterns/reader";
import { BookDown, Podcast, Share } from "lucide-react";

export async function getStaticProps() {
  const navigation = getChapterNavigation(undefined, allChapters);
  const epubDownloadLink = await getEpubDownloadLink();
  const audiobookDownloadLink = await getAudiobookDownloadLink();

  return {
    props: {
      meta: allMeta[0],
      chapters: allChapters,
      navigation,
      coverPath: await getCoverPath(),
      metadata: getGeneralMetadata(allMeta[0]),
      epubDownloadLink,
      audiobookDownloadLink,
    },
  };
}

export default function Home({
  meta,
  chapters,
  navigation,
  coverPath,
  metadata,
  epubDownloadLink,
  audiobookDownloadLink,
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
        <Sidebar
          meta={meta}
          chapters={chapters}
          navigation={navigation}
          epubDownloadLink={epubDownloadLink}
          audiobookDownloadLink={audiobookDownloadLink}
        >
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
                label: <Share size={16} />,
                action: shareMeta,
                buttonProps: {
                  size: "sm" as const,
                  variant: "secondary" as const,
                  className: "hidden md:flex",
                },
              },
              {
                label: <BookDown size={22} />,
                action: epubDownloadLink!,
                buttonProps: {
                  variant: "secondary" as const,
                  disabled: !epubDownloadLink,
                  className: "md:hidden",
                },
              },
              {
                label: <Podcast size={22} />,
                action: audiobookDownloadLink!,
                buttonProps: {
                  disabled: !audiobookDownloadLink,
                  className: "md:hidden",
                },
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
