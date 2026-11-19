import { describe, expect, it } from "vitest";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { cursorAt, docUnits } from "./sync-editor";

const codec = createMarkdownCodec();
const doc = (markdown: string) => PMNode.fromJSON(getSchema(editorExtensions), codec.parse(markdown));

describe("sync carets' units", () => {
  it("counts a prompt widget as one unit, whatever its unsent draft holds", () => {
    const markdown = '<!-- notefig:prompt id="blob_a" task="task_a" -->\n\nAfter the widget.\n';
    const plain = doc(markdown);
    const json = plain.toJSON();
    json.content[0].content = [{ type: "promptDraft", content: [{ type: "text", text: "an unsent draft" }] }];
    const drafted = PMNode.fromJSON(plain.type.schema, json);
    for (const shown of [plain, drafted]) {
      const [, after] = docUnits(shown);
      expect(shown.textBetween(after.from, after.to)).toBe("After the widget.");
      expect(cursorAt(shown, after.from + 3)).toEqual({ unit: 1, offset: 2 });
    }
  });
});
