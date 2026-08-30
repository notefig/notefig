/**
 * The prompt widget's strings live in this app's resource table, not in
 * @notefig/widgets — so nothing in the type system connects the `t()` calls
 * over there to the definitions over here. A key that goes missing renders as
 * its own name in the UI rather than throwing.
 *
 * This is that missing link: the package publishes the keys it resolves, and
 * this asserts every one is defined. It fails when either side drifts.
 */
import { describe, expect, it } from "vitest";
import { PROMPT_WIDGET_I18N_KEYS } from "@notefig/widgets";
import i18n from "@/utils/intl";

describe("prompt widget translations", () => {
  it("defines every key the widget package resolves", () => {
    const missing = PROMPT_WIDGET_I18N_KEYS.filter(
      (key) => !i18n.exists(key, { lng: "en" }),
    );
    expect(missing).toEqual([]);
  });
});
