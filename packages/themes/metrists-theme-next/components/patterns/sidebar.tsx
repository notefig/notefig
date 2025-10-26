import Link from "next/link";
import { Share } from "lucide-react";
import { BookOverview } from "./book-overview";
import { Button } from "@/components/ui/button";
import { ChapterNavigation } from "./chapter-navigation";
import { useShare, type ChapterLike } from "@/lib/utils";
import { MobileChapterDrawer } from "./mobile-chapter-drawer";
import type { Chapter, Meta } from "@/.contentlayer/generated";
import type { ChapterNavigationProps } from "./chapter-navigation";

export function Sidebar({
  meta,
  chapters,
  navigation,
  currentChapter,
  children,
}: {
  meta: Meta;
  chapters: Chapter[];
  navigation: ChapterNavigationProps["navigation"];
  currentChapter?: ChapterLike;
  children: React.ReactNode;
}) {
  const shareMeta = useShare(meta);

  return (
    <div className="relative max-w-4xl m-auto flex flex-col">
      <div className="w-full grid grid-cols-7">
        <div className="p-4 pb-0 col-span-7 m-auto w-full md:h-full md:col-span-5 md:p-8">
          {children}
          <div className="sticky z-10 w-full bottom-0 space-y-4 bg-background py-2 md:hidden">
            <ChapterNavigation navigation={navigation}>
              <Button
                variant="secondary"
                size="lg"
                className="text-md flex py-6 px-4"
                aria-label="Share"
                onClick={shareMeta}
              >
                <Share size={16} />
              </Button>
              <MobileChapterDrawer
                currentChapter={currentChapter}
                chapters={chapters}
              />
            </ChapterNavigation>
          </div>
        </div>
        <div className="col-span-2 space-y-4 border-l py-5 hidden md:block">
          <div className="px-3 py-2">
            <BookOverview
              title={meta.title}
              authors={meta.authors}
              datePublished={meta.date}
              actions={[
                {
                  label: "Download",
                  action: "/book.epub",
                  buttonProps: { size: "sm" },
                },
                {
                  label: <Share size={16} />,
                  action: shareMeta,
                  buttonProps: { size: "sm", variant: "secondary" },
                },
              ]}
              twoToneImageProps={{
                imageContainerClassName: "w-full",
              }}
            />
          </div>
          <div className="py-2 sticky top-0">
            <div className="px-3 py-2">
              <h2 className="mb-2 px-4 text-lg font-semibold tracking-tight">
                Chapters
              </h2>
              <div className="space-y-1">
                <ul>
                  {chapters.map((chapter) => (
                    <li key={`nav_chapters_links_${chapter.slug}`}>
                      <Button
                        asChild
                        variant={
                          currentChapter?.slug === chapter.slug
                            ? "default"
                            : "ghost"
                        }
                        className="w-full justify-start gap-2 text-wrap text-left h-auto"
                        title={chapter.title}
                      >
                        <Link href={`/${chapter.slug}`}>{chapter.title}</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
