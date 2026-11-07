import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { describeTaskMeta } from "@/modules/agents/react";
import { formatTimeAgo } from "@/utils/format";
import { HarnessRow } from "@/components/agent/harness-settings";
import { SessionRow } from "@/components/agent/sessions-panel";
import {
  StatusGlyph,
  type StatusGlyphState,
} from "@/components/agent/status-glyph";
import { HarnessLogo } from "@/components/agent/harness-logo";
import { AppEmbed } from "./app-embed";
import { DEMO_SESSIONS } from "./demo-fixtures";

/*
 * Real app components on the marketing page. Each demo renders the app's own
 * component — not a picture of it — inside `AppEmbed`, fed by the fake
 * environment in ./demo-host and ./demo-fixtures. The scripted ones live in
 * ./demo-prompt and ./demo-transcript.
 */

const noop = () => {};

// ---------- Harnesses: the Settings › Agents list ----------

const HARNESS_ROWS = [
  { id: "claude-code", found: true },
  { id: "opencode", found: true },
  { id: "devin", found: true },
  { id: "gemini-cli", found: false },
];

/** Settings › Agents: every agent Notefig runs, with the default checked. */
export function DemoHarnesses() {
  return (
    <AppEmbed zoom={0.82} width={380}>
      <div className="divide-y divide-border rounded-lg border border-border bg-card shadow-sm">
        {HARNESS_ROWS.map(({ id, found }) => {
          const definition = BUILT_IN_HARNESSES.find((h) => h.id === id);
          if (!definition) return null;
          return (
            <HarnessRow
              key={id}
              row={{
                definition,
                origin: "builtin",
                enabled: found,
                discovery: { harnessId: id, found, probedAt: 0 },
              }}
              isDefault={id === "claude-code"}
              isEditing={false}
              onMakeDefault={noop}
              onToggleEnabled={noop}
              onEdit={noop}
              onDelete={noop}
            />
          );
        })}
      </div>
    </AppEmbed>
  );
}

// ---------- Sessions: the sidebar's session list ----------

export function DemoSessions() {
  return (
    <AppEmbed zoom={0.82} width={380}>
      <div className="rounded-lg border border-border bg-card py-1 shadow-sm">
        {DEMO_SESSIONS.map(({ task, meta, attention }, index) => (
          <SessionRow
            key={task.taskId}
            task={task}
            meta={
              describeTaskMeta({
                task,
                needsAuth: false,
                isError: false,
                isUnavailable: false,
                ...meta,
              }) ?? formatTimeAgo(task.updatedAt)
            }
            isRunning={meta.isRunning}
            attention={attention ?? null}
            active={index === 0}
            onOpen={noop}
          />
        ))}
      </div>
    </AppEmbed>
  );
}

// ---------- Workspaces: what each one's agents are up to ----------

const WORKSPACES: {
  name: string;
  harnessId: string;
  state: StatusGlyphState;
  note: string;
}[] = [
  { name: "notefig", harnessId: "claude-code", state: "running", note: "Editing 3 files" },
  { name: "api-reference", harnessId: "opencode", state: "attention-bau", note: "Finished · 2m ago" },
  { name: "q3-planning", harnessId: "claude-code", state: "queued", note: "2 prompts queued" },
  { name: "handbook", harnessId: "devin", state: "attention-error", note: "Needs you" },
  { name: "blog", harnessId: "gemini-cli", state: "idle", note: "Idle" },
];

/** The app's own status vocabulary (StatusGlyph) and harness marks, one row
 *  per open workspace — the at-a-glance view the sidebar gives you. */
export function DemoWorkspaces() {
  return (
    <AppEmbed zoom={0.9} width={420}>
      <div className="divide-y divide-border rounded-lg border border-border bg-card shadow-sm">
        {WORKSPACES.map(({ name, harnessId, state, note }) => (
          <div key={name} className="flex items-center gap-2.5 px-3 py-2 text-xs">
            <span className="flex size-3 shrink-0 items-center justify-center">
              <StatusGlyph state={state} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
            <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
              {note}
            </span>
            <HarnessLogo harnessId={harnessId} className="size-3 text-muted-foreground" />
          </div>
        ))}
      </div>
    </AppEmbed>
  );
}
