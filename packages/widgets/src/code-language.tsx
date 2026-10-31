/**
 * A language picker in each code block's corner — the app's own picker
 * (the popover list the session settings use) — that sets the block's
 * `language`: its fence (```python), and what `codeHighlight` colours it
 * by. Common languages by their Shiki id, plus plain text; a language not
 * listed (an alias like `ts`) stays shown. Disabled where the editor is
 * read-only.
 */
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@notefig/ui/command";
import { touchesCode } from "./code-highlight";

const LANGUAGES = [
  "bash", "c", "cpp", "csharp", "css", "diff", "go", "html", "java",
  "javascript", "json", "jsx", "kotlin", "markdown", "php", "python", "ruby",
  "rust", "sql", "swift", "toml", "tsx", "typescript", "yaml",
];

const key = new PluginKey<DecorationSet>("codeLanguage");

function LanguagePicker({
  language,
  disabled,
  choose,
  done,
}: {
  language: string;
  disabled: () => boolean;
  choose: (language: string) => void;
  done: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listed = !language || LANGUAGES.includes(language);
  const plain = t("codeLanguagePlain");
  return (
    <Popover
      open={open}
      // Editability is read when it matters, not once at mount: a rename
      // makes the editor read-only while the picker is up.
      onOpenChange={(next) => setOpen(next && !disabled())}
      modal
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled()}
          aria-label={t("codeLanguageLabel")}
          className="absolute end-1 top-1 flex h-4 items-center rounded px-1 font-sans text-[0.625rem] leading-4 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {language || plain}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-auto min-w-[8rem] p-0"
        // Back to the document, not the trigger.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          done();
        }}
      >
        <Command className="text-[0.6875rem]">
          <CommandInput
            bare
            className="h-5 border-b px-1.5 text-[0.6875rem]"
            placeholder={t("codeLanguageFilter")}
          />
          <CommandList className="max-h-[14rem]">
            <CommandEmpty className="py-2 text-center text-[0.625rem] text-muted-foreground">
              {t("codeLanguageNoMatches")}
            </CommandEmpty>
            <CommandGroup className="p-0.5">
              {["", ...(listed ? [] : [language]), ...LANGUAGES].map((id) => (
                <CommandItem
                  key={id || "plain"}
                  value={id || plain}
                  onSelect={() => {
                    setOpen(false);
                    choose(id);
                  }}
                  className="gap-1 px-1.5 py-0.5 text-[0.6875rem] [&_svg]:size-2.5"
                >
                  <span className="flex-1">{id || plain}</span>
                  {id === language && <Check className="shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

function mount(view: EditorView, getPos: () => number | undefined, language: string) {
  const host = document.createElement("span");
  const root = createRoot(host);
  roots.set(host, root);
  root.render(
    <LanguagePicker
      language={language}
      disabled={() => !view.editable}
      choose={(next) => {
        if (!view.editable) return;
        // The widget sits just inside the block.
        const at = (getPos() ?? 0) - 1;
        const block = view.state.doc.nodeAt(at);
        if (block?.type.name !== "codeBlock") return;
        view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...block.attrs, language: next || null }));
      }}
      done={() => view.focus()}
    />,
  );
  return host;
}

function decorate(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const language = (node.attrs.language as string | null) ?? "";
    decorations.push(
      Decoration.widget(pos + 1, (view, getPos) => mount(view, getPos, language), {
        side: -1,
        // A new picker when the language changes; the same one otherwise.
        key: `language:${language}`,
        ignoreSelection: true,
        stopEvent: () => true,
        // After this update: unmounting during one of React's renders warns.
        destroy: (host) => queueMicrotask(() => roots.get(host as HTMLElement)?.unmount()),
      }),
    );
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function codeLanguagePicker(): Plugin {
  return new Plugin({
    key,
    state: {
      init: (_config, { doc }) => decorate(doc),
      // An edit away from every code block (most typing) only moves the
      // pickers along: walking the document for it cost ~1 ms a keystroke
      // in an 8,000-line one.
      apply: (tr, set) => {
        if (!tr.docChanged) return set;
        return touchesCode(tr) ? decorate(tr.doc) : set.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (state) => key.getState(state) },
  });
}
