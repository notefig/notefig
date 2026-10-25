import { z } from "zod";

/**
 * What a `widget_respond` call can be, one entry per kind: when the agent
 * should reach for it (`use`, the line the tool's description advertises)
 * and whether the round then waits on the user (`awaitsReply`, which the
 * widget's state machine reads). A new kind of response — multiple-choice
 * options, an approval — is a new entry here plus the fields it carries in
 * the schema below; the tool's description and the widget follow.
 */
export const WIDGET_RESPONSE_KINDS = {
  answer: {
    use: "your response to the request — the default",
    awaitsReply: false,
  },
  issue: {
    use: "a blocker or problem you hit and couldn't resolve",
    awaitsReply: false,
  },
  single_choice: {
    use:
      "you need the user to pick ONE of a few options before you can go on " +
      "(ask in `markdown`, list the choices in `options`). Ask here instead " +
      "of guessing or asking in prose; their pick (or a note they type " +
      "instead) arrives as your next prompt in this session",
    awaitsReply: true,
  },
  multiple_choice: {
    use:
      "like single_choice, but the user may pick ANY number of the " +
      "`options`; the picks arrive together as your next prompt",
    awaitsReply: true,
  },
} as const satisfies Record<string, { use: string; awaitsReply: boolean }>;

export type WidgetResponseKind = keyof typeof WIDGET_RESPONSE_KINDS;

/** The kinds that carry `options` for the user to pick from. */
const CHOICE_KINDS: ReadonlySet<WidgetResponseKind> = new Set([
  "single_choice",
  "multiple_choice",
]);

export function isChoiceKind(kind: WidgetResponseKind): boolean {
  return CHOICE_KINDS.has(kind);
}

/** What fits a widget heading and a chip; past these, the call fails and
 *  the agent is told to shorten it. */
export const WIDGET_RESPONSE_LIMITS = { title: 80, question: 200, option: 60 };

const KINDS = Object.keys(WIDGET_RESPONSE_KINDS) as [
  WidgetResponseKind,
  ...WidgetResponseKind[],
];

/**
 * The `widget_respond` payload — the agent's final answer to an in-document
 * prompt widget (MET-92).
 *
 * It lives in shared because two packages read it and neither owns the
 * other: the tool that declares it (`agent/tools/widget-respond.ts` in the
 * desktop app) and the widget that derives its done face from the
 * transcript entry's `rawInput` (`deriveWidgetResponse` in
 * @notefig/widgets). One definition is what keeps the writer and the reader
 * from drifting.
 *
 * One flat object whatever the kind, not a union per kind: a tool's input
 * schema must be an object at the top level (the Anthropic API refuses a
 * top-level anyOf), so a field only one kind carries (options, say) goes
 * here as optional and is checked against the kind with a refinement
 * (`options`: required by the choice kinds, refused by the rest). Flat
 * values only — strings and a list of strings, no nested objects, so
 * harness-side argument mangling (the OpenCode stringified-payload quirk
 * mcp-server.ts repairs) can't corrupt what the widget reads.
 */
export const WidgetRespondInputSchema = z
  .object({
    kind: z.enum(KINDS),
    markdown: z.string().min(1),
    title: z
      .string()
      .max(WIDGET_RESPONSE_LIMITS.title, shorten("a title", WIDGET_RESPONSE_LIMITS.title))
      .optional(),
    options: z
      .array(
        z
          .string()
          .min(1)
          .max(WIDGET_RESPONSE_LIMITS.option, shorten("an option", WIDGET_RESPONSE_LIMITS.option)),
      )
      .min(2)
      .max(8)
      .describe("The choices, for single_choice and multiple_choice only.")
      .optional(),
  })
  .superRefine((response, ctx) => {
    const choice = isChoiceKind(response.kind);
    // A choice's `markdown` is the question itself, read as the heading.
    if (choice && response.markdown.length > WIDGET_RESPONSE_LIMITS.question) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["markdown"],
        message: shorten("a question", WIDGET_RESPONSE_LIMITS.question),
      });
    }
    if (choice && !response.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: `${response.kind} needs options`,
      });
    }
    if (!choice && response.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "options are only for single_choice and multiple_choice",
      });
    }
  });

function shorten(what: string, limit: number): string {
  return `${what} is at most ${limit} characters — shorten it and call again`;
}

export type WidgetResponse = z.infer<typeof WidgetRespondInputSchema>;

/** The round this response ends waits on the user's reply. */
export function awaitsReply(response: WidgetResponse | null): boolean {
  return response !== null && WIDGET_RESPONSE_KINDS[response.kind].awaitsReply;
}

/**
 * The tool's name as it reaches the widget. ACP's ToolCallUpdate has no
 * tool-name field — identity travels in `title`, which harnesses mint from
 * the MCP tool name and the service normalizes (normalizeMcpToolName strips
 * the `mcp__notefig__` / `metrists_` prefixes) — so transcript entries carry
 * this plain string. Shared so the widget can match on it without importing
 * the tool.
 */
export const WIDGET_RESPOND_TOOL_NAME = "widget_respond";
