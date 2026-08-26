/**
 * Value-type registry for the frontmatter properties popover (MET-137).
 *
 * Each type bundles the three things the popover needs (same shape as the
 * blob registry, blobs/blob-type.ts): `matches` recognizes a parsed YAML
 * value, `Display` renders and edits it in its optimized format, and `Icon`
 * marks the key column. `resolveValueType` walks the registry in order and
 * falls back to the generic text type — which is also the icon every
 * unrecognized key gets.
 *
 * Recognized today: booleans (checkbox), ISO-ish dates (formatted, click to
 * edit raw), cron expressions (mono segments with a field legend tooltip),
 * and scalar lists (tag chips, comma-separated text while editing). Nested
 * maps/mixed arrays keep the raw-YAML textarea under the generic icon.
 */
import { useState, type KeyboardEvent, type ComponentType } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { format, isValid, parseISO } from "date-fns";
import {
  Calendar,
  Clock,
  List,
  ToggleLeft,
  Type,
  type LucideIcon,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Shared field styling + scalar parsing (also used by the popover)   */
/* ------------------------------------------------------------------ */

/** Borderless at rest; focus is indicated by the field's background alone
 * (bg-secondary reads clearly against the popover's bg-background). */
export const fieldFocusClass =
  "rounded bg-transparent outline-none focus:bg-secondary";
export const textInputClass = `h-6 w-full min-w-0 truncate px-1.5 text-xs ${fieldFocusClass}`;

/** Neutral value pill (booleans, list items). */
const chipClass =
  "inline-flex max-w-36 items-center gap-1 rounded-full border border-border/60 bg-secondary px-1.5 py-px text-[0.6875rem]";
export const yamlTextareaClass = `w-full resize-y px-1.5 py-0.5 font-mono text-xs ${fieldFocusClass}`;

/** A text field's content as a YAML value: comma-separated input becomes a
 * list (rendered as tag chips), other scalars keep their YAML type ("3" →
 * number, "true" → boolean), and anything unparseable or non-scalar stays
 * the literal string the user typed. */
export function parseScalarInput(text: string): unknown {
  if (text.trim() === "") return "";
  if (text.includes(",")) {
    const items = text
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (items.length > 0) return items.map(parseScalarItem);
  }
  return parseScalarItem(text);
}

function parseScalarItem(text: string): unknown {
  try {
    const value: unknown = parseYaml(text);
    return value !== null && typeof value === "object" ? text : value;
  } catch {
    return text;
  }
}

export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export const isScalarValue = (value: unknown) =>
  value === null || typeof value !== "object";

export function commitOnEnter(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Enter") {
    event.preventDefault();
    (event.target as HTMLElement).blur();
  }
}

/* ------------------------------------------------------------------ */
/* The registry contract                                              */
/* ------------------------------------------------------------------ */

export interface ValueDisplayProps {
  rowKey: string;
  value: unknown;
  onCommit: (value: unknown) => void;
}

export interface FrontmatterValueType {
  name: string;
  /** Key-column marker for values of this type. */
  Icon: LucideIcon;
  /** Whether this type owns the given parsed YAML value. */
  matches(value: unknown): boolean;
  /** Renders the value in its optimized format and commits edits. */
  Display: ComponentType<ValueDisplayProps>;
}

/* ------------------------------------------------------------------ */
/* Building block: rendered at rest, raw text input while editing     */
/* ------------------------------------------------------------------ */

function ClickToEditValue({
  rowKey,
  text,
  onCommitText,
  children,
  className = "px-1.5",
}: {
  rowKey: string;
  /** The raw text placed in the input when editing starts. */
  text: string;
  onCommitText: (text: string) => void;
  children: React.ReactNode;
  /** Padding override for the at-rest button (chips sit flush left). */
  className?: string;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={`Value of ${rowKey}`}
        defaultValue={text}
        spellCheck={false}
        onKeyDown={commitOnEnter}
        onBlur={(event) => {
          setEditing(false);
          if (event.target.value !== text) onCommitText(event.target.value);
        }}
        className={textInputClass}
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={`Value of ${rowKey}`}
      onClick={() => setEditing(true)}
      className={`flex min-h-6 min-w-0 grow flex-wrap items-center gap-1 overflow-hidden rounded text-left ${className}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

const booleanType: FrontmatterValueType = {
  name: "boolean",
  Icon: ToggleLeft,
  matches: (value) => typeof value === "boolean",
  // A neutral tag; like every type, clicking opens the text editor
  // ("true"/"false" as raw text) rather than acting directly.
  Display: ({ rowKey, value, onCommit }) => (
    <ClickToEditValue
      rowKey={rowKey}
      text={String(value)}
      // Flush left, like the list chips.
      className="px-0"
      onCommitText={(text) => onCommit(parseScalarInput(text))}
    >
      <span className={chipClass}>{String(value)}</span>
    </ClickToEditValue>
  ),
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

const dateType: FrontmatterValueType = {
  name: "date",
  Icon: Calendar,
  matches: (value) =>
    typeof value === "string" &&
    DATE_RE.test(value) &&
    isValid(parseISO(value.replace(" ", "T"))),
  Display: ({ rowKey, value, onCommit }) => {
    const raw = formatScalar(value);
    const parsed = parseISO(raw.replace(" ", "T"));
    const hasTime = raw.length > 10;
    return (
      <ClickToEditValue
        rowKey={rowKey}
        text={raw}
        onCommitText={(text) => onCommit(parseScalarInput(text))}
      >
        <span className="truncate text-xs">
          {format(parsed, hasTime ? "MMM d, yyyy HH:mm" : "MMM d, yyyy")}
        </span>
      </ClickToEditValue>
    );
  },
};

// Five or six whitespace-separated fields of cron vocabulary (digits, * / , -).
const CRON_FIELD_RE = /^[\d*/,-]+$/;

function isCronExpression(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  return fields.every((field) => CRON_FIELD_RE.test(field));
}

const CRON_LEGEND = ["minute", "hour", "day", "month", "weekday", "year"];

const cronType: FrontmatterValueType = {
  name: "cron",
  Icon: Clock,
  matches: isCronExpression,
  Display: ({ rowKey, value, onCommit }) => {
    const raw = formatScalar(value);
    const fields = raw.trim().split(/\s+/);
    return (
      <ClickToEditValue
        rowKey={rowKey}
        text={raw}
        onCommitText={(text) => onCommit(parseScalarInput(text))}
      >
        <span
          className="inline-flex gap-1 font-mono text-[0.6875rem]"
          title={CRON_LEGEND.slice(0, fields.length).join(" · ")}
        >
          {fields.map((field, index) => (
            <span
              key={index}
              title={CRON_LEGEND[index]}
              className="rounded bg-secondary/60 px-1 py-px"
            >
              {field}
            </span>
          ))}
        </span>
      </ClickToEditValue>
    );
  },
};

const listType: FrontmatterValueType = {
  name: "list",
  Icon: List,
  matches: (value) => Array.isArray(value) && value.every(isScalarValue),
  // Chips at rest; comma-joined text while editing, parsed back on blur.
  Display: ({ rowKey, value, onCommit }) => {
    const items = value as unknown[];
    const joined = items.map(formatScalar).join(", ");
    return (
      <ClickToEditValue
        rowKey={rowKey}
        text={joined}
        // Flush left: the chips themselves carry the visual inset.
        className="px-0"
        onCommitText={(text) => {
          const parsed = parseScalarInput(text);
          onCommit(
            Array.isArray(parsed) ? parsed : parsed === "" ? [] : [parsed],
          );
        }}
      >
        {items.map((item, index) => (
          <span
            key={`${index}-${String(item)}`}
            className={chipClass}
            title={formatScalar(item)}
          >
            <span
              aria-hidden
              className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
            />
            <span className="truncate">{formatScalar(item)}</span>
          </span>
        ))}
      </ClickToEditValue>
    );
  },
};

/** Nested maps / mixed arrays: the value itself as YAML. Generic icon —
 * only the display is specialized, the key isn't a recognized category. */
const nestedYamlType: FrontmatterValueType = {
  name: "yaml",
  Icon: Type,
  matches: (value) => !isScalarValue(value),
  Display: ({ value, onCommit }) => {
    const asYaml = stringifyYaml(value).replace(/\n$/, "");
    return (
      <textarea
        defaultValue={asYaml}
        spellCheck={false}
        rows={Math.max(2, asYaml.split("\n").length)}
        onBlur={(event) => {
          const text = event.target.value;
          if (text.replace(/\n+$/, "") === asYaml) return;
          try {
            onCommit(parseYaml(text));
          } catch {
            // Invalid YAML: leave the draft in place, commit nothing.
          }
        }}
        className={yamlTextareaClass}
      />
    );
  },
};

/** Fallback: plain scalar text input, generic icon. */
export const genericValueType: FrontmatterValueType = {
  name: "text",
  Icon: Type,
  matches: () => true,
  Display: ({ rowKey, value, onCommit }) => (
    <input
      defaultValue={formatScalar(value)}
      aria-label={`Value of ${rowKey}`}
      spellCheck={false}
      onKeyDown={commitOnEnter}
      onBlur={(event) => {
        // Compare as text: parseScalarInput may return a list (comma
        // input), which would never be === to the old value and could
        // convert an untouched comma-containing string on blur.
        if (event.target.value === formatScalar(value)) return;
        onCommit(parseScalarInput(event.target.value));
      }}
      className={textInputClass}
    />
  ),
};

/** Ordered: first match wins. Specific string shapes (date, cron) come
 * before the broad ones. */
export const frontmatterValueTypes: FrontmatterValueType[] = [
  booleanType,
  dateType,
  cronType,
  listType,
  nestedYamlType,
];

export function resolveValueType(value: unknown): FrontmatterValueType {
  return (
    frontmatterValueTypes.find((type) => type.matches(value)) ??
    genericValueType
  );
}
