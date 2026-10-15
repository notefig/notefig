import type { ComponentType } from "react";
import { IconAt, IconBolt, IconSparkles } from "@pierre/icons";

/** Each directive namespace's mark in the "@" menu — Pierre's set, like
 *  the file icons beside them. A namespace without one gets the "@". */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  model: IconSparkles,
  skill: IconBolt,
};

export function DirectiveIcon({
  namespace,
  className,
}: {
  namespace: string;
  className?: string;
}) {
  const Icon = ICONS[namespace] ?? IconAt;
  return <Icon className={className} aria-hidden />;
}
