import type { LucideIcon } from "lucide-react";
import { ChevronRight, History, Users, Workflow } from "lucide-react";
import { DownloadButton } from "./download-app-link";
import { APP_URL } from "./links";
import {
  DemoHarnesses,
  DemoHistory,
  DemoSessions,
  DemoWorkspaces,
} from "./demo/demo-cards";
import { DemoCollaboration, DemoPromptWidget } from "./demo/demo-prompt";
import { DemoTranscript } from "./demo/demo-transcript";
import {
  AGENTS,
  AgentMark,
  OpenSourceMock,
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
        <PromptSplit />
        <PillarsSection />
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
      <ul className="mx-auto mt-9 grid max-w-[360px] grid-cols-3 gap-x-4 gap-y-5 text-[var(--mk-faint)] sm:flex sm:max-w-none sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-12 sm:gap-y-6">
        {AGENTS.map(({ id, label }) => (
          <li
            key={id}
            className="flex items-center justify-center gap-1.5 whitespace-nowrap text-[14px] font-semibold tracking-[-0.01em] sm:gap-2 sm:text-[21px] sm:tracking-[-0.02em]"
          >
            <AgentMark id={id} size={20} />
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The three selling points, each shown with the part of the app that
 *  proves it. */
const PILLARS = [
  {
    kicker: "Open source",
    title: "Yours to read, run and change",
    body: "MIT licensed, on GitHub. No black box between you and your agents.",
    demo: () => <OpenSourceMock />,
  },
  {
    kicker: "Markdown first",
    title: "A better harness, built on .md",
    body: "Agents work in plain Markdown you can read, diff and version, so context never gets lost in a chat log.",
    demo: () => (
      <DemoPromptWidget
        reference="Onboarding templates came up in every customer call."
        zoom={0.8}
        width={360}
      />
    ),
  },
  {
    kicker: "Metaharness",
    title: "Every agent, configured once",
    body: "Claude Code, OpenCode, Devin and any ACP agent side by side, each with its own settings.",
    demo: () => <DemoHarnesses />,
  },
];

function PillarsSection() {
  return (
    <section id="why" className="site-column pb-[120px] pt-[100px]">
      <h2 className="mk-h2 max-w-[1000px]" style={{ textWrap: "pretty" }}>
        Open source. Markdown first. Every agent.{" "}
        <span className="text-[var(--mk-muted)]">
          A harness you can read, on files you own, running the agents you
          already use.
        </span>
      </h2>
      <div className="mt-[96px] grid gap-12 md:grid-cols-3 md:gap-10">
        {PILLARS.map(({ kicker, title, body, demo: Demo }) => (
          <article key={kicker} className="min-w-0">
            <div className="mk-well aspect-square p-6">
              <Demo />
            </div>
            <p className="mk-kicker mt-7 text-[var(--mk-accent-text)]">{kicker}</p>
            <h3 className="mk-card-title mt-1.5">{title}</h3>
            <p className="mk-card-body max-w-[320px]">{body}</p>
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
    <section
      id="features"
      className="site-column grid items-center gap-14 pb-[100px] pt-[120px] md:grid-cols-[1fr_1.15fr] md:gap-16"
    >
      <div>
        <Kicker color="var(--mk-accent-text)" icon={Users}>
          Collaboration
        </Kicker>
        <h2 className="mk-h2 mt-4 max-w-[440px]">
          You and your agents, in one document.
        </h2>
        <p className="mk-body mt-5 max-w-[440px]">
          Ask Claude Code about one part and OpenCode about another. They work
          side by side while you keep writing, and every answer lands in the
          doc.
        </p>
        <WebAppLink className="mt-10" />
      </div>
      <div className="mk-well mk-well-dots min-w-0 p-6 md:p-12">
        <DemoCollaboration
          document={KICKOFF_NOTES}
          zoom={0.64}
          width={460}
          height={680}
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
            title="Sessions that keep going"
            body="Queue work and come back to results."
          >
            <div className="flex h-full items-center">
              <DemoSessions />
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
    <article className="mk-card min-w-0 p-6 sm:p-8">
      <div className="min-h-[268px] flex-1">{children}</div>
      <h3 className="mk-card-title mt-8">{title}</h3>
      <p className="mk-card-body max-w-[440px]">{body}</p>
    </article>
  );
}

type Tile = { id: string; label: string; row: number; col: number };

/** Wide screens: 19 × 64px tiles + 18 × 12px gaps span the page column,
 *  logos around the heading. */
const WIDE_FIELD = {
  columns: 19,
  rows: 6,
  tiles: [
    { id: "claude-code", label: "Claude Code", row: 1, col: 4 },
    { id: "codex", label: "Codex", row: 1, col: 14 },
    { id: "cursor", label: "Cursor", row: 2, col: 12 },
    { id: "opencode", label: "OpenCode", row: 3, col: 3 },
    { id: "gemini-cli", label: "Gemini CLI", row: 4, col: 10 },
    { id: "devin", label: "Devin", row: 4, col: 6 },
    { id: "claude-code", label: "Claude Code", row: 3, col: 16 },
  ] as Tile[],
};

/** Phones: five columns, the heading across the top rows, every logo in the
 *  rows below it. */
const NARROW_FIELD = {
  columns: 5,
  rows: 7,
  mask: "radial-gradient(ellipse 85% 75% at 50% 50%, #000 60%, transparent 100%)",
  tiles: [
    { id: "claude-code", label: "Claude Code", row: 3, col: 1 },
    { id: "codex", label: "Codex", row: 3, col: 3 },
    { id: "cursor", label: "Cursor", row: 4, col: 0 },
    { id: "opencode", label: "OpenCode", row: 4, col: 2 },
    { id: "gemini-cli", label: "Gemini CLI", row: 4, col: 4 },
    { id: "devin", label: "Devin", row: 5, col: 1 },
  ] as Tile[],
};

function TileField({
  columns,
  rows,
  tiles,
  mask,
  className,
}: {
  columns: number;
  rows: number;
  tiles: Tile[];
  /** Overrides the default fade (tuned for the wide field). */
  mask?: string;
  className: string;
}) {
  const byCell = new Map(tiles.map((tile) => [tile.row * columns + tile.col, tile]));
  return (
    <div
      className={`mk-tiles ${className}`}
      style={{
        gridTemplateColumns: `repeat(${columns}, 64px)`,
        ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : {}),
      }}
      aria-hidden="true"
    >
      {Array.from({ length: columns * rows }, (_, cell) => {
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
  );
}

function AgentsSection() {
  return (
    <section
      id="agents"
      className="relative overflow-hidden bg-[linear-gradient(var(--mk-chip),var(--mk-section)_70%,var(--mk-white))] pb-[120px] pt-[72px]"
    >
      <TileField {...WIDE_FIELD} className="hidden md:grid" />
      <TileField {...NARROW_FIELD} className="grid md:hidden" />
      <div className="pointer-events-none absolute inset-x-0 top-[72px] flex justify-center px-5">
        <div className="flex max-w-[520px] flex-col items-center rounded-[40px] bg-[radial-gradient(closest-side,var(--mk-chip)_65%,transparent)] px-2 pb-8 pt-6 sm:px-10 text-center">
          <Kicker color="var(--mk-sage-text)" icon={Workflow}>
            Metaharness
          </Kicker>
          <h2 className="mk-h2 mt-3">Every agent, one workspace</h2>
          <div className="pointer-events-auto mt-8 flex items-center justify-center gap-2 sm:gap-3">
            <DownloadButton />
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
