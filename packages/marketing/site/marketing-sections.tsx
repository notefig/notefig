import type { LucideIcon } from "lucide-react";
import { ChevronRight, History, Sparkles, Workflow } from "lucide-react";
import { DownloadAppLink } from "./download-app-link";
import { APP_URL } from "./links";
import {
  DemoHarnesses,
  DemoHistory,
  DemoPromptWidget,
  DemoSessions,
  DemoTranscript,
  DemoWorkspaces,
} from "./demo/demo-cards";
import {
  AGENTS,
  AgentMark,
  OrbitMock,
  PairingMock,
  PipelineMock,
} from "./marketing-mocks";

/**
 * Marketing beats below the product window: the agents it runs, the
 * workflow in three cards, two feature splits, a bento of the rest, and the
 * harness field with the closing download.
 * No social proof — we don't have client logos or quotes yet.
 */
export function MarketingSections() {
  return (
    <>
      <HarnessStrip />
      <div className="mk-white">
        <WorkflowSection />
        <PromptSplit />
        <HistorySplit />
      </div>
      <BentoSection />
      <AgentsSection />
    </>
  );
}

function HarnessStrip() {
  return (
    <section className="site-column pb-[88px] text-center">
      <p className="text-[16px] font-medium text-[var(--mk-body)]">
        Works with the agents you already use
      </p>
      <ul className="mt-9 flex flex-wrap items-center justify-center gap-x-12 gap-y-6 text-[var(--mk-faint)]">
        {AGENTS.map(({ id, label }) => (
          <li
            key={id}
            className="flex items-center gap-2 text-[21px] font-semibold tracking-[-0.02em]"
          >
            <AgentMark id={id} size={22} />
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}

const WORKFLOW = [
  {
    title: "Bring your own agent",
    body: "Every agent you use, in one place.",
    demo: () => <DemoHarnesses />,
  },
  {
    title: "Prompt from any document",
    body: "Press / and ask. Answers land in the doc.",
    demo: () => (
      <DemoPromptWidget
        script="summon"
        reference="Onboarding templates came up in every customer call."
        zoom={0.8}
        width={360}
      />
    ),
  },
  {
    title: "Sessions that keep going",
    body: "Queue work and come back to results.",
    demo: () => <DemoSessions />,
  },
];

function WorkflowSection() {
  return (
    <section id="features" className="site-column pb-[120px] pt-[140px]">
      <h2 className="mk-h2 max-w-[1000px]" style={{ textWrap: "pretty" }}>
        One harness for all your agents.{" "}
        <span className="text-[var(--mk-muted)]">
          Working in your documents, not a chat window beside them.
        </span>
      </h2>
      <div className="mt-[96px] grid gap-12 md:grid-cols-3 md:gap-10">
        {WORKFLOW.map(({ title, body, demo: Demo }) => (
          <article key={title} className="min-w-0">
            <div className="mk-well aspect-square p-6">
              <Demo />
            </div>
            <h3 className="mk-card-title mt-7">{title}</h3>
            <p className="mk-card-body max-w-[300px]">{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

const KICKOFF_NOTES = {
  heading: "Q3 kickoff",
  body: "Onboarding templates came up in every customer call. Sam will scope a small-team plan, and Lee wants search in beta for everyone before the offsite.",
};

function PromptSplit() {
  return (
    <section className="site-column grid items-center gap-14 py-[100px] md:grid-cols-[1fr_1.15fr] md:gap-16">
      <div>
        <Kicker color="var(--mk-accent-text)" icon={Sparkles}>
          Inline prompts
        </Kicker>
        <h2 className="mk-h2 mt-4 max-w-[420px]">
          Ask for an edit without leaving the page.
        </h2>
        <p className="mk-body mt-5 max-w-[420px]">
          Prompt from any document, pull in other files with @, and pick the
          agent that answers.
        </p>
        <WebAppLink className="mt-10" />
      </div>
      <div className="mk-well mk-well-dots min-h-[420px] min-w-0 p-6 md:aspect-[524/480] md:p-10">
        <DemoPromptWidget
          script="lifecycle"
          document={KICKOFF_NOTES}
          zoom={0.8}
          width={420}
          className="relative w-full min-w-0"
        />
      </div>
    </section>
  );
}

const HISTORY_POINTS = [
  "Automatic commits",
  "One-click revert",
  "Separate from your own git history",
];

function HistorySplit() {
  return (
    <section className="site-column grid items-center gap-14 pb-[140px] pt-[100px] md:grid-cols-[1.15fr_1fr] md:gap-16">
      <div className="mk-well mk-well-dots order-last min-h-[380px] min-w-0 p-6 md:order-first md:aspect-[524/480] md:p-10">
        <DemoHistory width={400} />
      </div>
      <div>
        <Kicker color="var(--mk-sage-text)" icon={History}>
          History
        </Kicker>
        <h2 className="mk-h2 mt-4 max-w-[420px]">
          See what changed, and undo it.
        </h2>
        <p className="mk-body mt-5 max-w-[420px]">
          Every change is committed as you work, so any agent edit is one
          click from undone.
        </p>
        <ul className="mt-9 space-y-2.5">
          {HISTORY_POINTS.map((point) => (
            <li
              key={point}
              className="flex items-center gap-2.5 text-[15px] font-medium text-[var(--mk-ink)]"
            >
              <span aria-hidden="true">✓</span>
              {point}
            </li>
          ))}
        </ul>
        <WebAppLink className="mt-10" />
      </div>
    </section>
  );
}

/** The secondary call to action: the same app, in the browser. */
function WebAppLink({ className }: { className?: string }) {
  return (
    <a
      href={APP_URL}
      target="_blank"
      rel="noopener"
      className={`mk-btn mk-btn-soft ${className ?? ""}`}
    >
      Try it in the browser
      <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" />
    </a>
  );
}

function BentoSection() {
  return (
    <section className="bg-[var(--mk-section)] py-[120px]">
      <div className="site-column">
        <div className="mx-auto max-w-[540px] text-center">
          <h2 className="mk-h2">Built for getting work done</h2>
          <p className="mk-body mt-4">
            Hand off work. Keep working. Come back to results.
          </p>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-2">
          <BentoCard
            title="Agent sessions"
            body="Chat with an agent that edits your whole workspace."
          >
            <DemoTranscript width={640} height={400} />
          </BentoCard>
          <BentoCard
            title="Workspaces keep working"
            body="Close the window; your agents carry on."
          >
            <div className="flex h-full items-center">
              <DemoWorkspaces />
            </div>
          </BentoCard>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-3">
          <BentoCard
            title="Git, built in"
            body="Every turn committed. Sync in one click."
          >
            <div className="flex h-full items-center">
              <PipelineMock />
            </div>
          </BentoCard>
          <BentoCard
            title="Agents on the web"
            body="Run agents on your machine, drive them from the browser."
          >
            <div className="flex h-full items-center">
              <PairingMock />
            </div>
          </BentoCard>
          <BentoCard
            title="Fits your stack"
            body="Your agents, remotes and files, connected."
          >
            <div className="flex h-full items-center">
              <OrbitMock />
            </div>
          </BentoCard>
        </div>
      </div>
    </section>
  );
}

function BentoCard({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <article className="mk-card min-w-0 p-8">
      <div className="min-h-[268px] flex-1">{children}</div>
      <h3 className="mk-card-title mt-8">{title}</h3>
      <p className="mk-card-body max-w-[440px]">{body}</p>
    </article>
  );
}

/** The tile field spans the page column: 19 × 64px tiles + 18 × 12px gaps. */
const TILE_COLUMNS = 19;
const TILE_ROWS = 6;

const AGENT_TILES: { id: string; label: string; row: number; col: number }[] = [
  { id: "claude-code", label: "Claude Code", row: 1, col: 4 },
  { id: "codex", label: "Codex", row: 1, col: 14 },
  { id: "cursor", label: "Cursor", row: 2, col: 12 },
  { id: "opencode", label: "OpenCode", row: 3, col: 3 },
  { id: "gemini-cli", label: "Gemini CLI", row: 4, col: 10 },
  { id: "devin", label: "Devin", row: 4, col: 6 },
  { id: "claude-code", label: "Claude Code", row: 3, col: 16 },
];

function AgentsSection() {
  const byCell = new Map(
    AGENT_TILES.map((tile) => [tile.row * TILE_COLUMNS + tile.col, tile]),
  );
  return (
    <section
      id="agents"
      className="relative overflow-hidden bg-[linear-gradient(var(--mk-chip),var(--mk-section)_70%,var(--mk-white))] pb-[120px] pt-[72px]"
    >
      <div className="mk-tiles" aria-hidden="true">
        {Array.from({ length: TILE_COLUMNS * TILE_ROWS }, (_, cell) => {
          const tile = byCell.get(cell);
          return tile ? (
            <span key={cell} className="mk-tile" data-filled title={tile.label}>
              <AgentMark id={tile.id} size={26} />
            </span>
          ) : (
            <span key={cell} className="mk-tile" />
          );
        })}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-[72px] flex justify-center px-5">
        <div className="flex max-w-[520px] flex-col items-center rounded-[40px] bg-[radial-gradient(closest-side,var(--mk-chip)_65%,transparent)] px-10 pb-8 pt-6 text-center">
          <Kicker color="var(--mk-sage-text)" icon={Workflow}>
            Metaharness
          </Kicker>
          <h2 className="mk-h2 mt-3">Every agent, one workspace</h2>
          <div className="pointer-events-auto mt-8 flex flex-wrap items-center justify-center gap-3">
            <DownloadAppLink className="mk-btn mk-btn-dark" />
            <a
              href={APP_URL}
              target="_blank"
              rel="noopener"
              className="mk-btn mk-btn-link"
            >
              Open the web app
              <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Kicker({
  color,
  icon: Icon,
  children,
}: {
  color: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <p className="mk-kicker" style={{ color }}>
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      {children}
    </p>
  );
}
