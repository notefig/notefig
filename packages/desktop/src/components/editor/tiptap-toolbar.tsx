import type { Editor } from "@tiptap/core";
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  StrikethroughIcon,
  TableIcon,
  UnderlineIcon,
} from "lucide-react";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  TiptapHeadingButton,
  TiptapMarkButton,
  TiptapBlockButton,
  TiptapLinkButton,
  TiptapTableInsertButton,
} from "./tiptap-toolbar-buttons";
import { FrontmatterToolbarButton } from "./frontmatter-popover";

interface TiptapToolbarProps {
  editor: Editor;
  onLinkToggle: () => void;
}

export function TiptapToolbar({ editor, onLinkToggle }: TiptapToolbarProps) {
  return (
    <FixedToolbar>
      <ScrollArea className="flex justify-start shrink-0 gap-1">
        <TiptapHeadingButton editor={editor} level={1} tooltip="Heading 1">
          <Heading1Icon />
        </TiptapHeadingButton>
        <TiptapHeadingButton editor={editor} level={2} tooltip="Heading 2">
          <Heading2Icon />
        </TiptapHeadingButton>
        <TiptapHeadingButton editor={editor} level={3} tooltip="Heading 3">
          <Heading3Icon />
        </TiptapHeadingButton>

        <Separator orientation="vertical" className="h-6" />

        <TiptapMarkButton editor={editor} format="bold" tooltip="Bold">
          <BoldIcon />
        </TiptapMarkButton>
        <TiptapMarkButton editor={editor} format="italic" tooltip="Italic">
          <ItalicIcon />
        </TiptapMarkButton>
        <TiptapMarkButton
          editor={editor}
          format="underline"
          tooltip="Underline"
        >
          <UnderlineIcon />
        </TiptapMarkButton>
        <TiptapMarkButton
          editor={editor}
          format="strike"
          tooltip="Strikethrough"
        >
          <StrikethroughIcon />
        </TiptapMarkButton>

        <Separator orientation="vertical" className="h-6" />

        <TiptapBlockButton
          editor={editor}
          format="bulletList"
          tooltip="Bullet List"
        >
          <ListIcon />
        </TiptapBlockButton>
        <TiptapBlockButton
          editor={editor}
          format="orderedList"
          tooltip="Numbered List"
        >
          <ListOrderedIcon />
        </TiptapBlockButton>

        <Separator orientation="vertical" className="h-6" />

        <TiptapBlockButton
          editor={editor}
          format="blockquote"
          tooltip="Blockquote"
        >
          <QuoteIcon />
        </TiptapBlockButton>
        <TiptapBlockButton
          editor={editor}
          format="codeBlock"
          tooltip="Code Block"
        >
          <CodeIcon />
        </TiptapBlockButton>

        <Separator orientation="vertical" className="h-6" />

        <TiptapTableInsertButton editor={editor} tooltip="Insert Table">
          <TableIcon />
        </TiptapTableInsertButton>

        <Separator orientation="vertical" className="h-6" />

        <TiptapLinkButton
          editor={editor}
          onToggle={onLinkToggle}
          tooltip="Link"
        >
          <LinkIcon />
        </TiptapLinkButton>
      </ScrollArea>

      {/* Outside the scroll area: FixedToolbar is justify-between, so the
          properties popover trigger pins to the toolbar's far end. */}
      <FrontmatterToolbarButton editor={editor} />
    </FixedToolbar>
  );
}
