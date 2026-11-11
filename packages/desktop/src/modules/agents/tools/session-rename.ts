import { z } from "zod";
import type { AgentTool } from "@notefig/agent";

export const SESSION_RENAME_TOOL_NAME = "session_rename";

/** How long a session's name may be: the widget's chip and the sessions
 *  panel show it whole. */
const TITLE_MAX = 60;

export const SessionRenameInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "the title is at least 2 characters")
    .max(TITLE_MAX, `the title is at most ${TITLE_MAX} characters — shorten it and call again`),
});

export type SessionRenameInput = z.infer<typeof SessionRenameInputSchema>;

/**
 * Name the session (MET-284). Until the agent does, a session goes by its
 * first prompt, cut short, which says what was asked first rather than
 * what the session is for. The name is the session's identity on every
 * widget that joins it, so the agent picks it once: the runtime refuses a
 * second rename, and a name another session in the workspace already has
 * (which leaves the rename unspent). `widget_respond` refuses until the
 * session is named, so no widget turn ends on an unnamed session.
 */
export const sessionRename: AgentTool<SessionRenameInput, { renamed: true; title: string }> = {
  name: SESSION_RENAME_TOOL_NAME,
  title: "agentToolSessionRename",
  description:
    `Name this session, once: call it on your first turn, as soon as you ` +
    `understand what the session is for, before \`widget_respond\`. The ` +
    `user tells their sessions apart by this name, on every widget in the ` +
    `document that continues it. Name the goal of the session, not the ` +
    `current step ("Investor intro rewrite", not "Shorten paragraph"), in ` +
    `2–4 words. The name is permanent: it can't be changed later, so get ` +
    `it right the first time. It must differ from the workspace's other ` +
    `sessions; if it doesn't, the call fails, lists their names, and you ` +
    `can call again with a distinct one.`,
  input: SessionRenameInputSchema,
  async execute(ctx, { title }) {
    const result = ctx.agents.task(ctx.taskId).rename(title);
    return result.ok ? { ok: true, value: { renamed: true, title } } : result;
  },
};
