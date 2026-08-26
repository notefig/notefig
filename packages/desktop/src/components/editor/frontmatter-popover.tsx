/**
 * The document properties popover, MET-137 — the ONLY surface where
 * frontmatter is viewed and edited (the node renders nothing in the page,
 * see frontmatter-node.tsx). Anchored to a tag-icon button at the right end
 * of the editor toolbar; the button is hidden for editors whose document
 * carries no frontmatter node (schema-only contexts).
 *
 * Values render through the value-type registry
 * (frontmatter-value-types.tsx): each recognized type supplies the key
 * column's icon and the optimized display/editor for the value; everything
 * else falls back to the generic text type and icon.
 *
 * Edits go through the yaml library's Document API (parseDocument → mutate
 * → toString) so comments, key order, and keys the popover can't render
 * survive byte-for-byte; renames mutate the pair's key scalar in place for
 * the same reason. Every commit is one setFrontmatterYaml call — a normal
 * history transaction the autosave path treats like typing.
 */
import { useState, type FocusEvent } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { parseDocument } from "yaml";
import {
  isMap,
  isScalar,
  type Document as YamlDocument,
  type Scalar,
} from "yaml";
import { SquareLibrary, Trash2 } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { ToolbarButton } from "@/components/ui/toolbar";
import { getFrontmatterYaml, setFrontmatterYaml } from "./frontmatter-node";
import {
  commitOnEnter,
  fieldFocusClass,
  genericValueType,
  parseScalarInput,
  resolveValueType,
  yamlTextareaClass,
} from "./frontmatter-value-types";

export function FrontmatterToolbarButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  // null = no frontmatter node yet (setFrontmatterYaml creates it on the
  // first property commit) — the popover just edits an empty document.
  const yaml =
    useEditorState({
      editor,
      selector: ({ editor }) => getFrontmatterYaml(editor),
    }) ?? "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div>
          <ToolbarButton
            tooltip="Properties"
            pressed={open}
            onClick={() => setOpen((o) => !o)}
          >
            <SquareLibrary />
          </ToolbarButton>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        sideOffset={6}
        // Plain theme background (same tone as the page); the border and
        // shadow carry the elevation. background-image:none strips the
        // stock texture-surface noise tile so the color stays flat.
        className="w-72 bg-background p-2 shadow-lg [background-image:none]"
        // Radix focuses the first tabbable on open — the title row's key
        // input, which then renders text-selected as if mid-rename.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <FrontmatterEditor
          yaml={yaml}
          onChange={(text) => setFrontmatterYaml(editor, text)}
        />
      </PopoverContent>
    </Popover>
  );
}

type Row = { key: string; value: unknown };

const keyInputClass = `h-6 w-full min-w-0 truncate px-1 text-xs text-muted-foreground ${fieldFocusClass}`;
const rowClass =
  "group/row flex min-h-6 items-start gap-2 rounded hover:bg-muted/30";

export function FrontmatterEditor({
  yaml,
  onChange,
}: {
  yaml: string;
  onChange: (yaml: string) => void;
}) {
  const doc = parseDocument(yaml || "");
  const structured =
    doc.errors.length === 0 &&
    (doc.contents === null ||
      (isMap(doc.contents) &&
        doc.contents.items.every((item) => isScalar(item.key))));

  const rows: Row[] = structured
    ? Object.entries((doc.toJS() ?? {}) as Record<string, unknown>).map(
        ([key, value]) => ({ key, value }),
      )
    : [];
  const keys = rows.map((r) => r.key);

  /** Re-parse, mutate, write back — one history transaction per commit. */
  const commit = (mutate: (target: YamlDocument) => void) => {
    const next = parseDocument(yaml || "");
    mutate(next);
    let text = next.toString().replace(/\n$/, "");
    // An emptied map stringifies as "{}" and a blank doc as "null" — both
    // mean "no properties", which serializes as no frontmatter at all.
    if (text === "{}" || text === "null") text = "";
    if (text !== yaml) onChange(text);
  };

  const setKey = (key: string, value: unknown) =>
    commit((target) => target.set(key, value));

  const deleteKey = (key: string) => commit((target) => target.delete(key));

  /** In-place rename: mutate the pair's key scalar so the entry keeps its
   * position and attached comments (delete+set would move it to the end). */
  const renameKey = (oldKey: string, newKey: string) =>
    commit((target) => {
      if (!isMap(target.contents)) return;
      const items = target.contents.items;
      if (
        items.some((p) => isScalar(p.key) && String(p.key.value) === newKey)
      ) {
        return;
      }
      const pair = items.find(
        (p) => isScalar(p.key) && String(p.key.value) === oldKey,
      );
      if (pair) (pair.key as Scalar).value = newKey;
    });

  const commitRaw = (event: FocusEvent<HTMLTextAreaElement>) => {
    const text = event.target.value.replace(/\n+$/, "");
    if (text !== yaml) onChange(text);
  };

  return (
    <div className="flex w-full flex-col">
      <div className="px-1.5 pt-0.5 pb-2">
        <div className="text-xs font-medium">Properties</div>
        <div className="pt-0.5 text-xs text-muted-foreground">
          Stored as frontmatter in this file
        </div>
      </div>

      {!structured ? (
        <div>
          <textarea
            key={yaml}
            defaultValue={yaml}
            onBlur={commitRaw}
            spellCheck={false}
            rows={Math.max(3, yaml.split("\n").length)}
            className={yamlTextareaClass}
          />
          <p className="pt-0.5 text-xs text-muted-foreground">
            Shown as raw text — this frontmatter isn’t a simple key/value map
            {doc.errors.length > 0 ? " (parse error)" : ""}.
          </p>
        </div>
      ) : (
        <>
          {rows.map(({ key, value }) => {
            const valueType = resolveValueType(value);
            return (
              <div key={key} className={rowClass}>
                <div className="flex h-6 w-24 shrink-0 items-center gap-1 pl-1">
                  {/* h-4 = 1rem = the 24px grid lucide is drawn on (at the
                      150% rem baseline) — the only size where strokes land
                      on whole pixels; anything smaller renders soft. Same
                      reason the toolbar icons (size-4) are crisp. */}
                  <valueType.Icon
                    aria-hidden
                    className="h-4 w-4 shrink-0 text-muted-foreground/60"
                  />
                  <input
                    key={`${yaml}:${key}`}
                    defaultValue={key}
                    aria-label={`Property name ${key}`}
                    spellCheck={false}
                    onKeyDown={commitOnEnter}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (!next || next === key || keys.includes(next)) {
                        event.target.value = key;
                        return;
                      }
                      renameKey(key, next);
                    }}
                    className={keyInputClass}
                  />
                </div>
                <valueType.Display
                  key={`${yaml}:${key}:value`}
                  rowKey={key}
                  value={value}
                  onCommit={(next) => setKey(key, next)}
                />
                {/* Own column, vertically centered on the whole row
                    (self-center overrides the row's items-start). */}
                <button
                  type="button"
                  aria-label={`Delete ${key}`}
                  className="grid h-6 w-6 shrink-0 place-items-center self-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                  onClick={() => deleteKey(key)}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}

          {rows.length === 0 && (
            <p className="px-1.5 pb-1 text-xs text-muted-foreground">
              No properties yet — name one to get started.
            </p>
          )}
          <NewPropertyRow existingKeys={keys} onCommit={setKey} />
        </>
      )}
    </div>
  );
}

/**
 * The always-present empty row under the last property: name input + value
 * input. Enter or focus leaving the row with a usable name commits the
 * property and the row clears itself, ready for the next one.
 */
function NewPropertyRow({
  existingKeys,
  onCommit,
}: {
  existingKeys: string[];
  onCommit: (key: string, value: unknown) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = key.trim();
    if (!trimmed || existingKeys.includes(trimmed)) return;
    onCommit(trimmed, parseScalarInput(value));
    setKey("");
    setValue("");
  };

  // Unlike existing rows (chromeless until focused), these read as real
  // input fields — bordered, faintly filled, placeholder-labeled — so it's
  // obvious this is where a new property gets typed, especially when the
  // popup has no properties at all.
  const newFieldClass =
    "h-6 min-w-0 truncate rounded border border-border/50 bg-secondary/40 px-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:bg-secondary";

  return (
    <div
      className="mt-1 flex min-h-6 items-start gap-2"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      }}
      onBlur={(event) => {
        // Only when focus leaves the whole row (name ↔ value tabbing stays).
        if (!event.currentTarget.contains(event.relatedTarget)) submit();
      }}
    >
      <div className="flex h-6 w-24 shrink-0 items-center gap-1 pl-1">
        <genericValueType.Icon
          aria-hidden
          className="h-4 w-4 shrink-0 text-muted-foreground/40"
        />
        <input
          placeholder="name"
          aria-label="New property name"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className={`${newFieldClass} w-full`}
        />
      </div>
      <input
        placeholder="value"
        aria-label="New property value"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className={`${newFieldClass} w-full`}
      />
      {/* spacer matching the delete-button column so the inputs align */}
      <div className="w-6 shrink-0" />
    </div>
  );
}
