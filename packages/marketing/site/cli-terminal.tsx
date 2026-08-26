import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

const COMMANDS = [
  { command: "npx notefig watch", result: "watching ./" },
  { command: "npx notefig build", result: "built dist/" },
  { command: "npx notefig publish vercel", result: "published" },
] as const;

const SPINNER = ["|", "/", "-", "\\"] as const;

const SCRIPT = COMMANDS.map(({ command }) => command).join("\n");

type Line =
  | { kind: "input"; command: string; chars: number }
  | { kind: "spin"; frame: number }
  | { kind: "result"; text: string };

type Cancel = { cancelled: boolean };
type SetLines = Dispatch<SetStateAction<Line[] | null>>;

function sleep(ms: number, signal: Cancel): Promise<void> {
  return new Promise((resolve) => {
    if (signal.cancelled) {
      resolve();
      return;
    }
    window.setTimeout(resolve, ms);
  });
}

function replaceLast(prev: Line[] | null, line: Line): Line[] {
  const next = [...(prev ?? [])];
  next[next.length - 1] = line;
  return next;
}

async function typeCommand(
  command: string,
  signal: Cancel,
  setLines: SetLines,
): Promise<void> {
  setLines((prev) => [...(prev ?? []), { kind: "input", command, chars: 0 }]);
  for (let i = 1; i <= command.length; i++) {
    if (signal.cancelled) return;
    setLines((prev) =>
      replaceLast(prev, { kind: "input", command, chars: i }),
    );
    await sleep(command[i - 1] === " " ? 70 : 38, signal);
  }
}

async function playSpinner(signal: Cancel, setLines: SetLines): Promise<void> {
  setLines((prev) => [...(prev ?? []), { kind: "spin", frame: 0 }]);
  for (let frame = 1; frame <= 14; frame++) {
    if (signal.cancelled) return;
    setLines((prev) => replaceLast(prev, { kind: "spin", frame }));
    await sleep(70, signal);
  }
}

function finishStep(prev: Line[] | null, result: string): Line[] {
  const next = [...(prev ?? [])];
  if (next[next.length - 1]?.kind === "spin") next.pop();
  next.push({ kind: "result", text: result });
  return next;
}

async function playStep(
  step: (typeof COMMANDS)[number],
  signal: Cancel,
  setLines: SetLines,
): Promise<void> {
  await typeCommand(step.command, signal, setLines);
  await sleep(160, signal);
  if (signal.cancelled) return;
  await playSpinner(signal, setLines);
  if (signal.cancelled) return;
  setLines((prev) => finishStep(prev, step.result));
  await sleep(400, signal);
}

async function playOnce(
  signal: Cancel,
  setLines: SetLines,
  setFading: (value: boolean) => void,
): Promise<void> {
  setFading(true);
  await sleep(180, signal);
  if (signal.cancelled) return;
  setLines(() => []);
  setFading(false);
  for (const step of COMMANDS) {
    await playStep(step, signal, setLines);
    if (signal.cancelled) return;
  }
  await sleep(2200, signal);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return inView;
}

function StaticTranscript() {
  return (
    <>
      {COMMANDS.map(({ command, result }) => (
        <div key={command} className="cli-line">
          <div>
            <span className="cli-prompt">❯</span> {command}
          </div>
          <div className="cli-result">{result}</div>
        </div>
      ))}
      <div>
        <span className="cli-prompt">❯</span>
      </div>
    </>
  );
}

/**
 * Dark terminal card: types the three CLI commands, shows a short spinner
 * and a generic success line, then loops. Reduced-motion and off-screen
 * (including prerender) show the finished transcript.
 */
export function CliTerminal() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(rootRef);
  const play = !reduced && inView;
  const [lines, setLines] = useState<Line[] | null>(null);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!play) {
      setLines(null);
      setFading(false);
      return;
    }

    const signal: Cancel = { cancelled: false };

    async function runLoop(): Promise<void> {
      while (!signal.cancelled) {
        await playOnce(signal, setLines, setFading);
      }
    }

    void runLoop();
    return () => {
      signal.cancelled = true;
    };
  }, [play]);

  return (
    <div
      ref={rootRef}
      className="cli-terminal select-text"
      role="region"
      aria-label="Notefig CLI commands"
    >
      <div className="cli-terminal-chrome" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <pre className="sr-only">{SCRIPT}</pre>
      <div
        className={fading ? "cli-terminal-body is-fading" : "cli-terminal-body"}
        aria-hidden="true"
      >
        {lines ? <AnimatedTranscript lines={lines} /> : <StaticTranscript />}
      </div>
    </div>
  );
}

function AnimatedTranscript({ lines }: { lines: Line[] }) {
  const finished =
    lines.filter((line) => line.kind === "result").length === COMMANDS.length;

  return (
    <>
      {lines.map((line, i) => {
        const last = i === lines.length - 1;
        if (line.kind === "input") {
          return (
            <div key={`in-${i}`} className="cli-line">
              <span className="cli-prompt">❯</span>{" "}
              {line.command.slice(0, line.chars)}
              {last ? <span className="cli-caret" /> : null}
            </div>
          );
        }
        if (line.kind === "spin") {
          return (
            <div key={`spin-${i}`} className="cli-result">
              {SPINNER[line.frame % SPINNER.length]}
            </div>
          );
        }
        return (
          <div key={`out-${i}`} className="cli-result">
            {line.text}
          </div>
        );
      })}
      {finished ? (
        <div>
          <span className="cli-prompt">❯</span> <span className="cli-caret" />
        </div>
      ) : null}
    </>
  );
}
