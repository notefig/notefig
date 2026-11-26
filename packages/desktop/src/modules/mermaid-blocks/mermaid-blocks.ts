/**
 * Mermaid blocks (```mermaid) draw themselves as their diagram wherever the
 * page holds one — documents, chat replies — once their element is defined
 * (@notefig/widgets/mermaid-block/element). Pele, which draws them, loads
 * with the first diagram, not here.
 */
import { defineModule } from "@notefig/core";
import { defineMermaidBlockElement } from "@notefig/widgets/mermaid-block/element";

export const mermaidBlocksModule = defineModule({
  name: "mermaid-blocks",
  boot: () => {
    defineMermaidBlockElement();
  },
});
