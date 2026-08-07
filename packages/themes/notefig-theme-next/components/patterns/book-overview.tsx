import { MouseEventHandler, useMemo, type ReactNode } from "react";
import Link, { type LinkProps } from "next/link";
import { Button, ButtonProps } from "@/components/ui/button";
import { TwoToneImage, TwoToneImageProps } from "./two-tone-image";
import { cn } from "@/lib/utils";

export type BookOverviewActionProps = {
  label: ReactNode;
  buttonProps: Partial<ButtonProps>;
} & (
  | {
      action: string;
      linkProps?: Partial<LinkProps>;
    }
  | {
      linkProps?: undefined;
      action: MouseEventHandler<HTMLButtonElement>;
    }
);

export interface BookOverviewProps {
  title: string;
  authors?: string[];
  cover?: string;
  datePublished?: string;
  actions?: BookOverviewActionProps[];
  twoToneImageProps?: Partial<TwoToneImageProps>;
  titleProps?: Partial<React.HTMLAttributes<HTMLHeadingElement>>;
}

export function BookOverview({
  title,
  cover,
  datePublished,
  authors = [],
  twoToneImageProps = {},
  titleProps = {},
  actions = [],
}: BookOverviewProps) {
  const [imageContainerClassNameOverride, restOfImageProps] = useMemo(() => {
    const { imageContainerClassName, ...rest } = twoToneImageProps;
    return [imageContainerClassName, rest];
  }, [twoToneImageProps]);

  const [titleClassNameOverride, restOfTitleProps] = useMemo(() => {
    const { className, ...rest } = titleProps;
    return [className, rest];
  }, [titleProps]);

  const formattedDatePublished = useMemo(() => {
    if (!datePublished) return "";
    const date = new Date(datePublished);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }, [datePublished]);

  return (
    <div className="flex flex-col gap-2 w-full">
      {cover ? (
        <TwoToneImage
          imageContainerClassName={imageContainerClassNameOverride}
          imageProps={{ src: cover, title }}
          aspectRatio="square"
          {...restOfImageProps}
        />
      ) : (
        <></>
      )}
      <h3
        className={cn("text-md ", titleClassNameOverride)}
        {...restOfTitleProps}
      >
        {title}
      </h3>
      <div className="max-w-full overflow-hidden overflow-ellipsis whitespace-nowrap text-muted-foreground">
        {authors?.join(", ")}{" "}
        {formattedDatePublished ? `• ${formattedDatePublished}` : ""}
      </div>
      <div className="flex gap-2 flex-wrap">
        {actions?.map(
          (
            { label, action, buttonProps, linkProps }: BookOverviewActionProps,
            index: number,
          ) =>
            typeof action === "string" ? (
              <Link
                key={`book-overview-action-${action}`}
                href={action}
                {...linkProps}
              >
                <Button {...buttonProps}>{label}</Button>
              </Link>
            ) : (
              <Button
                key={`book-overview-action-${index}`}
                onClick={action}
                {...buttonProps}
              >
                {label}
              </Button>
            ),
        )}
      </div>
    </div>
  );
}
