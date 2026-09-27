import {
  CircleCheck,
  CircleDashed,
  Star,
} from "lucide-react";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import { BRAND_MARKS, type BrandName } from "./brand-marks";
import { GITHUB_URL } from "./links";

/*
 * Illustrations for ideas the app has no single component for: a turn's
 * trip from agent to remote, the CLI's pairing code, the agents and tools
 * around the workspace. Everything the
 * app does render lives in ./demo as the real component.
 */

/**
 * A third-party mark, tinted to the surrounding text colour so it sits in the
 * brand palette. `native` keeps the vendor's own colour (Claude's terracotta
 * already belongs to the palette).
 */
export function Brand({
  name,
  size = 16,
  native = false,
  className,
}: {
  name: BrandName;
  size?: number;
  native?: boolean;
  className?: string;
}) {
  const mark: { color: string; path: string; evenOdd?: boolean } =
    BRAND_MARKS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={native ? mark.color : "currentColor"}
      fillRule={mark.evenOdd ? "evenodd" : undefined}
      className={className}
      aria-hidden="true"
    >
      <path d={mark.path} />
    </svg>
  );
}

/** Agents the page names. The app's built-in harnesses draw with its own
 *  HarnessLogo; the rest with their brand marks, same monochrome style. */
export const AGENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "opencode", label: "OpenCode" },
  { id: "gemini-cli", label: "Gemini CLI" },
  { id: "devin", label: "Devin" },
] as const;

const BRANDED_AGENTS: Record<string, BrandName> = {
  codex: "Codex",
  cursor: "Cursor",
};

export function AgentMark({ id, size }: { id: string; size: number }) {
  const brand = BRANDED_AGENTS[id];
  return brand ? (
    <Brand name={brand} size={size} />
  ) : (
    <span className="inline-flex shrink-0" style={{ width: size, height: size }}>
      <HarnessLogo harnessId={id} className="size-full" />
    </span>
  );
}

// ---------- Bento ----------

const PIPELINE = [
  { icon: "Claude" as const, title: "Claude Code", sub: "Edited 3 files" },
  { icon: "Git" as const, title: "History", sub: "Checkpoint saved" },
  { icon: "GitHub" as const, title: "GitHub", sub: "Pushed to main" },
];

export function PipelineMock() {
  return (
    <ul className="mx-auto w-full max-w-[300px] space-y-4">
      {PIPELINE.map((step, index) => (
        <li
          key={step.title}
          className="mk-ui flex items-center gap-3 rounded-2xl px-4 py-3"
          style={{ marginInline: index === 1 ? -8 : 0 }}
        >
          <span className="flex size-9 items-center justify-center rounded-xl bg-[var(--mk-chip)]">
            <Brand name={step.icon} size={17} native={step.icon === "Claude"} />
          </span>
          <span className="text-left">
            <span className="block text-[14px] font-semibold">
              {step.title}
            </span>
            <span className="block text-[13px] font-medium text-[var(--mk-muted)]">
              {step.sub}
            </span>
          </span>
          <CircleCheck
            size={18}
            className="ml-auto fill-[var(--mk-sage)] text-[var(--mk-cream)]"
            aria-hidden="true"
          />
        </li>
      ))}
    </ul>
  );
}

/** A deterministic QR-like pattern: the pairing code shown for `notefig agent`. */
function QrPattern() {
  const size = 21;
  const cells: { x: number; y: number }[] = [];
  const finder = (x: number, y: number) =>
    (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (finder(x, y)) continue;
      if (((x * 7 + y * 13 + x * y) % 5) % 2 === 0) cells.push({ x, y });
    }
  }
  const eye = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={7} height={7} rx={1.6} fill="#4a3a32" />
      <rect x={x + 1} y={y + 1} width={5} height={5} rx={1} fill="#fffbf7" />
      <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.6} fill="#4a3a32" />
    </g>
  );
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-full" aria-hidden="true">
      {cells.map(({ x, y }) => (
        <rect
          key={`${x}.${y}`}
          x={x + 0.08}
          y={y + 0.08}
          width={0.84}
          height={0.84}
          rx={0.25}
          fill="#4a3a32"
        />
      ))}
      {eye(0, 0)}
      {eye(size - 7, 0)}
      {eye(0, size - 7)}
    </svg>
  );
}

export function PairingMock() {
  return (
    <div className="mk-ui mx-auto flex w-full max-w-[260px] flex-col items-center px-6 pb-5 pt-6">
      <div className="size-[124px]">
        <QrPattern />
      </div>
      <p className="mt-4 font-mono text-[15px] font-semibold tracking-[0.18em]">
        K7Q-4MX
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-[12px] font-medium text-[var(--mk-muted)]">
        <CircleDashed
          size={12}
          className="mk-spinner"
          strokeWidth={2.25}
          aria-hidden="true"
        />
        Waiting for your machine…
      </p>
    </div>
  );
}

/** The open-source pillar: the repository, its license, one command away. */
export function OpenSourceMock() {
  return (
    <div className="mk-ui w-full max-w-[330px] px-5 py-5 text-left">
      <div className="flex items-center gap-2.5">
        <Brand name="GitHub" size={20} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          notefig<span className="text-[var(--mk-faint)]"> / </span>notefig
        </span>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-[var(--mk-line)] px-2.5 text-[12px] font-semibold transition-colors hover:bg-[var(--mk-chip)]"
        >
          <Star size={12} strokeWidth={2.25} aria-hidden="true" />
          Star
        </a>
      </div>
      <p className="mt-2 text-[13px] font-medium text-[var(--mk-soft)]">
        The open-source AI metaharness.
      </p>
      <div className="mt-3 flex gap-1.5">
        <span className="rounded-full bg-[var(--mk-chip)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--mk-soft)]">
          MIT License
        </span>
        <span className="rounded-full bg-[var(--mk-chip)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--mk-soft)]">
          TypeScript
        </span>
      </div>
      <div className="mt-4 truncate rounded-xl bg-[var(--mk-section)] px-3 py-2 font-mono text-[11.5px] text-[var(--mk-body)]">
        <span className="text-[var(--mk-accent-text)]">$</span> git clone
        github.com/notefig/notefig
      </div>
    </div>
  );
}
