export type FocusDomain = "modal" | "palette" | "sidebar" | "editor" | "misc";

export type FocusTiming = "immediate" | "next-frame" | "when-mounted";

/**
 * Optional caret placement carried by editor-targeted intents. The arbiter
 * treats it as opaque data — the editor resolver (editor-store) interprets
 * it when the intent wins. Without one, the resolver's default applies
 * (collapse any stale range so regaining focus never re-paints an old
 * selection).
 */
export type EditorCaretPlacement = {
  /** Put the caret in the nearest textblock before the node at `pos` —
   *  Escape out of an inline widget returns the cursor to where the user
   *  was before summoning it, not past it. */
  type: "before-node";
  pos: number;
};

export type FocusTarget =
  | { type: "editor"; filePath: string; caret?: EditorCaretPlacement }
  | { type: "element"; key: string };

export interface FocusIntentInput {
  id?: string;
  domain: FocusDomain;
  target: FocusTarget;
  priority: number;
  reason: string;
  when?: FocusTiming;
  ttlMs?: number;
  /** An explicit user hand-off (e.g. Escape out of a composer). Resolvers
   *  may move focus out of an active text entry only when this is set —
   *  ambient intents (mount, layout reclaim, tab activation) must never
   *  yank a text entry's focus. */
  steal?: boolean;
}

export interface FocusIntent extends FocusIntentInput {
  id: string;
  when: FocusTiming;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

export interface FocusOwner {
  id: string;
  domain: FocusDomain;
  target: FocusTarget;
  priority: number;
  reason: string;
  focusedAt: number;
}

export interface FocusArbiterOptions {
  cooldownMs?: number;
  defaultTtlMs?: number;
  maxMountAttempts?: number;
  now?: () => number;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  queueMicrotask?: (cb: () => void) => void;
}

interface InternalFocusIntent extends FocusIntent {
  sequence: number;
}

const DEFAULT_COOLDOWN_MS = 150;
const DEFAULT_TTL_MS = 1500;
const DEFAULT_MAX_MOUNT_ATTEMPTS = 20;

export class FocusArbiter {
  private readonly cooldownMs: number;
  private readonly defaultTtlMs: number;
  private readonly maxMountAttempts: number;
  private readonly now: () => number;
  private readonly resolvers = new Map<
    FocusTarget["type"],
    (intent: FocusIntent) => boolean
  >();
  private readonly requestFrame: (cb: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly setTimer: (
    cb: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;
  private readonly queueMicrotaskFn: (cb: () => void) => void;

  private pending = new Map<string, InternalFocusIntent>();
  private suppressUntil = new Map<FocusDomain | "all", number>();

  private owner: FocusOwner | null = null;
  private activeEditorId: string | null = null;
  private cooldownUntil = 0;
  private sequence = 0;
  private idCounter = 0;

  private microtaskScheduled = false;
  private frameScheduled = false;
  private rafId: number | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: FocusArbiterOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxMountAttempts =
      options.maxMountAttempts ?? DEFAULT_MAX_MOUNT_ATTEMPTS;
    this.now = options.now ?? (() => Date.now());
    this.requestFrame =
      options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame =
      options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));
    this.queueMicrotaskFn =
      options.queueMicrotask ??
      ((cb) => {
        Promise.resolve().then(cb);
      });
  }

  request(input: FocusIntentInput): string {
    if (this.disposed) {
      return "";
    }

    const now = this.now();
    const id = input.id ?? this.createId();
    const intent: InternalFocusIntent = {
      id,
      domain: input.domain,
      target: input.target,
      priority: input.priority,
      reason: input.reason,
      when: input.when ?? "immediate",
      ttlMs: input.ttlMs ?? this.defaultTtlMs,
      steal: input.steal ?? false,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? this.defaultTtlMs),
      attempts: 0,
      sequence: ++this.sequence,
    };

    this.pending.set(id, intent);

    if (intent.when === "immediate") {
      this.scheduleMicrotaskFlush();
    } else {
      this.scheduleFrameFlush();
    }

    return id;
  }

  suppress(scope: FocusDomain | "all", ms: number): void {
    if (this.disposed) return;

    this.suppressUntil.set(scope, this.now() + ms);
  }

  setActiveEditor(filePath: string | null): void {
    this.activeEditorId = filePath;
  }

  flush(): void {
    if (this.disposed) return;

    const now = this.now();
    this.pruneExpired(now);
    this.pruneSuppression(now);

    const intents = this.sortedPendingIntents();
    if (intents.length === 0) return;

    const winner = intents.find((intent) => this.isEligible(intent));
    if (!winner) {
      this.retryMountIntents(intents);
      return;
    }

    const blockedByCooldown =
      now < this.cooldownUntil &&
      this.owner !== null &&
      winner.priority <= this.owner.priority;

    if (blockedByCooldown) {
      this.scheduleCooldownFlush();
      return;
    }

    const resolver = this.resolvers.get(winner.target.type);
    if (!resolver) {
      this.removeIntent(winner.id);
      return;
    }

    const focused = resolver(winner);
    if (!focused) {
      if (winner.when === "when-mounted") {
        this.retryIntent(winner);
      } else {
        this.removeIntent(winner.id);
      }
      return;
    }

    this.removeIntent(winner.id);

    const owner: FocusOwner = {
      id: winner.id,
      domain: winner.domain,
      target: winner.target,
      priority: winner.priority,
      reason: winner.reason,
      focusedAt: now,
    };

    this.owner = owner;
    this.cooldownUntil = now + this.cooldownMs;

    if (this.pending.size > 0) {
      this.scheduleFrameFlush();
    }
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  registerResolver(
    type: FocusTarget["type"],
    resolver: (intent: FocusIntent) => boolean,
  ): void {
    this.resolvers.set(type, resolver);
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.suppressUntil.clear();

    if (this.rafId !== null) {
      this.cancelFrame(this.rafId);
      this.rafId = null;
    }

    if (this.cooldownTimer) {
      this.clearTimer(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private createId(): string {
    this.idCounter += 1;
    return `focus-${this.idCounter}`;
  }

  private sortedPendingIntents(): InternalFocusIntent[] {
    const intents = Array.from(this.pending.values());

    intents.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }

      if (a.createdAt !== b.createdAt) {
        return b.createdAt - a.createdAt;
      }

      return b.sequence - a.sequence;
    });

    return intents;
  }

  private isEligible(intent: InternalFocusIntent): boolean {
    if (this.isSuppressed(intent.domain)) {
      return false;
    }

    if (intent.target.type === "editor") {
      if (!this.activeEditorId) return false;
      if (this.activeEditorId !== intent.target.filePath) return false;
    }

    return true;
  }

  private isSuppressed(domain: FocusDomain): boolean {
    const now = this.now();
    const all = this.suppressUntil.get("all") ?? 0;
    const scoped = this.suppressUntil.get(domain) ?? 0;
    return all > now || scoped > now;
  }

  private pruneExpired(now: number): void {
    for (const [id, intent] of this.pending.entries()) {
      if (intent.expiresAt > now) continue;
      this.removeIntent(id);
    }
  }

  private pruneSuppression(now: number): void {
    for (const [scope, until] of this.suppressUntil.entries()) {
      if (until <= now) {
        this.suppressUntil.delete(scope);
      }
    }
  }

  private retryMountIntents(intents: InternalFocusIntent[]): void {
    const waiting = intents.some((intent) => intent.when === "when-mounted");
    if (waiting) {
      this.scheduleFrameFlush();
    }
  }

  private retryIntent(intent: InternalFocusIntent): void {
    intent.attempts += 1;
    if (intent.attempts >= this.maxMountAttempts) {
      this.removeIntent(intent.id);
      return;
    }

    this.pending.set(intent.id, intent);
    this.scheduleFrameFlush();
  }

  private removeIntent(id: string): void {
    this.pending.delete(id);
  }

  private scheduleMicrotaskFlush(): void {
    if (this.microtaskScheduled || this.disposed) return;

    this.microtaskScheduled = true;
    this.queueMicrotaskFn(() => {
      this.microtaskScheduled = false;
      this.flush();
    });
  }

  private scheduleFrameFlush(): void {
    if (this.frameScheduled || this.disposed) return;

    this.frameScheduled = true;
    this.rafId = this.requestFrame(() => {
      this.frameScheduled = false;
      this.rafId = null;
      this.flush();
    });
  }

  private scheduleCooldownFlush(): void {
    if (this.cooldownTimer || this.disposed) return;

    const delay = Math.max(0, this.cooldownUntil - this.now());
    this.cooldownTimer = this.setTimer(() => {
      this.cooldownTimer = null;
      this.flush();
    }, delay);
  }
}

export const focusArbiter = new FocusArbiter({});

focusArbiter.registerResolver("element", (intent) => {
  if (intent.target.type !== "element") return false;

  const selector = `[data-focus-key="${escapeForAttributeSelector(intent.target.key)}"]`;
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) return false;

  if (document.activeElement === el) return true;

  // Never steal focus from an open overlay or an active text entry.
  // Radix menus/dialogs re-grab focus synchronously, so stealing creates a
  // per-frame tug-of-war with `when-mounted` retries; stealing from a text
  // entry blurs it, which cancels rename/create flows mid-typing — and for
  // the main editor, a late-firing when-mounted intent (e.g. the sidebar's
  // focus-first-item request) would hijack keystrokes mid-typing: the next
  // Enter activates the newly focused tree button and opens that file.
  // Returning false lets when-mounted intents keep retrying until the
  // overlay closes or the user leaves the text entry (or the attempt/TTL
  // cap expires) without ever yanking focus.
  if (
    isFocusInsideOpenOverlay(document.activeElement) ||
    isTextEntryActive(document.activeElement)
  ) {
    return false;
  }

  el.focus({ preventScroll: true });
  return document.activeElement === el;
});

function isFocusInsideOpenOverlay(activeElement: Element | null): boolean {
  if (!(activeElement instanceof HTMLElement)) return false;
  return !!activeElement.closest(
    '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]',
  );
}

export function requestElementFocus(
  key: string,
  options: {
    domain?: FocusDomain;
    priority?: number;
    reason?: string;
    when?: FocusTiming;
  } = {},
): string {
  return focusArbiter.request({
    domain: options.domain ?? "misc",
    target: { type: "element", key },
    priority: options.priority ?? 10,
    reason: options.reason ?? "element-focus",
    when: options.when ?? "immediate",
  });
}

function escapeForAttributeSelector(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isSidebarTextEntryActive(
  activeElement: Element | null,
): boolean {
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.closest("[data-sidebar]")) return false;

  return isTextEntryActive(activeElement);
}

/**
 * Whether the given element is (inside) a text-editing context anywhere in
 * the app — a form field, a contenteditable, or the main editor.
 */
export function isTextEntryActive(activeElement: Element | null): boolean {
  if (!(activeElement instanceof HTMLElement)) return false;

  return !!activeElement.closest(
    'input, textarea, [contenteditable="true"], [role="textbox"]',
  );
}
