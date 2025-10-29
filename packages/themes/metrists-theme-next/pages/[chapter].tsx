import Head from "next/head";
import { Header } from "@/components/patterns/header";
import { Sidebar } from "@/components/patterns/sidebar";
import { allMeta, allChapters } from "contentlayer/generated";
import {
  getChapterMetadata,
  getChapterNavigation,
  getCoverPath,
  getEpubDownloadLink,
  invariant,
  useShare,
} from "@/lib/utils";
import { Reader } from "@/components/patterns/reader";

export function getStaticPaths() {
  const paths = allChapters.map((chapter) => ({
    params: { chapter: chapter.slug },
  }));

  return { paths, fallback: false };
}

export async function getStaticProps({
  params,
}: ReturnType<typeof getStaticPaths>["paths"][0]) {
  const chapter = allChapters.find(
    (chapter) => chapter.slug === params.chapter,
  );
  invariant(chapter, `Chapter not found for slug: ${params.chapter}`);
  const navigation = getChapterNavigation(chapter, allChapters);
  const epubDownloadLink = await getEpubDownloadLink();

  return {
    props: {
      meta: allMeta[0],
      chapters: allChapters,
      navigation,
      chapter,
      coverPath: await getCoverPath(),
      metadata: getChapterMetadata(allMeta[0], chapter),
      epubDownloadLink,
    },
  };
}

export default function Index({
  meta,
  chapters,
  navigation,
  chapter,
  coverPath,
  metadata,
  epubDownloadLink,
}: Awaited<ReturnType<typeof getStaticProps>>["props"]) {
  const shareMeta = useShare(meta);
  return (
    <>
      <Head>
        <title>{metadata.title}</title>
        <meta name="description" content={metadata.description} />
      </Head>
      <Header meta={meta} coverPath={coverPath}>
        <Sidebar meta={meta} chapters={chapters} navigation={navigation} epubDownloadLink={epubDownloadLink} currentChapter={chapter}>
          <div className="my-4">
            <Reader markdown={chapter.body} />
          </div>
        </Sidebar>
      </Header>
    </>
  );
}
