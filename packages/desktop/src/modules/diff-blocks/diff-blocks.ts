/**
 * Diff blocks (```ts diff=src/app.ts) draw themselves wherever rendered
 * markdown holds one — chat, widget responses — once their element is
 * defined (@notefig/widgets/diff-block/element).
 */
import { defineModule } from "@notefig/core";
import { defineDiffBlockElement } from "@notefig/widgets/diff-block/element";

export const diffBlocksModule = defineModule({
  name: "diff-blocks",
  boot: () => defineDiffBlockElement(),
});
