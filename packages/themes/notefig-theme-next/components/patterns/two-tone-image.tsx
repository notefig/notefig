import { cn } from "@/lib/utils";

export interface TwoToneImageProps {
  imageProps: React.ImgHTMLAttributes<any>;
  imageContainerClassName?: string;
  imageBlurClassName?: string;
  aspectRatio?: "portrait" | "square";
}

export function TwoToneImage({
  imageContainerClassName,
  imageBlurClassName,
  aspectRatio,
  imageProps,
}: TwoToneImageProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md bg-cover bg-center bg-no-repeat",
        imageContainerClassName,
      )}
      style={{ backgroundImage: `url(${imageProps.src})` }}
    >
      <div
        className={cn(
          "bg-primary-300 flex h-full w-full justify-center overflow-hidden rounded-md bg-neutral-300 bg-opacity-20 p-8 backdrop-blur-3xl dark:bg-neutral-600 dark:bg-opacity-20",
          imageBlurClassName,
        )}
      >
        <img
          {...imageProps}
          className={cn(
            "h-auto w-auto rounded-sm object-cover shadow-2xl",
            aspectRatio === "portrait" ? "aspect-[3/4]" : "aspect-square",
            imageProps.className ?? "",
          )}
        />
      </div>
    </div>
  );
}
