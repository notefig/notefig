import i18n from "@/utils/intl";
import type { TFunction } from "i18next";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function getLocalizedCommandKeywords(
  t: TFunction,
  key: string,
): string[] {
  const localized = t(key, {
    returnObjects: true,
    defaultValue: [],
  });

  if (isStringArray(localized)) {
    return localized;
  }

  const english = i18n.getFixedT("en")(key, {
    returnObjects: true,
    defaultValue: [],
  });

  if (isStringArray(english)) {
    return english;
  }

  return [];
}
