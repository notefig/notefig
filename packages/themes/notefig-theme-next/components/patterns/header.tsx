import Link from "next/link";
import { ThemeSwitch } from "./theme-switch";
import { Separator } from "@/components/ui/separator";
import type { Meta } from "contentlayer/generated";

export function Header({
  meta,
  children,
  coverPath,
}: {
  meta: Meta;
  coverPath: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div>
        <div className="flex justify-between align-center h-[80px] px-4 md:px-8">
          <div className="flex items-center">
            <Link href="/" title={`${meta.title} Cover`}>
              <img
                src={coverPath}
                alt={meta.title}
                className="aspect-square w-12 h-12 object-cover rounded-md"
              />
            </Link>
          </div>
          <div className="flex items-center">
            <ThemeSwitch />
          </div>
        </div>
        <Separator />
      </div>
      {children}
    </>
  );
}
