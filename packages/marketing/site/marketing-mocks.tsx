import {
  CircleCheck,
  CircleDashed,
} from "lucide-react";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import { BRAND_MARKS, type BrandName } from "./brand-marks";

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

/** Agents (the app's own harness marks) and the tools they work with. */
const ORBIT: {
  key: string;
  mark: { harness: string } | { brand: BrandName };
  x: number;
  y: number;
  rotate: number;
}[] = [
  { key: "github", mark: { brand: "GitHub" }, x: 8, y: 16, rotate: -8 },
  { key: "claude", mark: { harness: "claude-code" }, x: 40, y: 2, rotate: 6 },
  { key: "opencode", mark: { harness: "opencode" }, x: 72, y: 20, rotate: -4 },
  { key: "gitlab", mark: { brand: "GitLab" }, x: 22, y: 54, rotate: 8 },
  { key: "devin", mark: { harness: "devin" }, x: 55, y: 46, rotate: -10 },
  { key: "git", mark: { brand: "Git" }, x: 84, y: 60, rotate: 6 },
  { key: "codex", mark: { harness: "codex" }, x: 4, y: 84, rotate: -4 },
  { key: "markdown", mark: { brand: "Markdown" }, x: 40, y: 82, rotate: 4 },
  { key: "cursor", mark: { harness: "cursor" }, x: 70, y: 92, rotate: -8 },
];

export function OrbitMock() {
  return (
    <div
      className="relative mx-auto h-[220px] w-full max-w-[280px]"
      aria-hidden="true"
    >
      {ORBIT.map(({ key, mark, x, y, rotate }) => (
        <span
          key={key}
          className="mk-ui flex size-[52px] items-center justify-center rounded-2xl"
          style={{
            position: "absolute",
            left: `${x}%`,
            top: `${y}%`,
            transform: `translate(-20%, -30%) rotate(${rotate}deg)`,
          }}
        >
          {"harness" in mark ? (
            <AgentMark id={mark.harness} size={22} />
          ) : (
            <Brand name={mark.brand} size={22} />
          )}
        </span>
      ))}
    </div>
  );
}
