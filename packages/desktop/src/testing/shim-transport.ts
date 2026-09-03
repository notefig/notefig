/**
 * Env-gated frontend transport for the real-backend e2e shim (MET-73).
 *
 * When `VITE_TEST_BACKEND=shim`, this installs a `window.__TAURI_INTERNALS__`
 * that routes Tauri `invoke()` to the shim's `POST /invoke/{cmd}` over HTTP and
 * delivers shim WS events to `listen()` callbacks. Because the app detects Tauri
 * by the presence of `__TAURI_INTERNALS__` (see `utils/platform.ts`), installing
 * it makes the real `TauriPlatformAdapter` + `src/entities` run against the real
 * Rust `fs_ops`/`search` on a real temp filesystem — the substrate MET-83 builds
 * on — instead of the browser IndexedDB adapter.
 *
 * PRODUCTION SAFETY: the entire body is behind the `VITE_TEST_BACKEND === "shim"`
 * check, which Vite statically evaluates to `false` in a normal build, so this
 * dead-code-eliminates to nothing — the transport can never install in prod.
 *
 * Must be imported before anything reads the platform or the `platformAdapter`
 * singleton (it is the first import in `main.tsx`).
 *
 * Test-only infra: `invoke` deliberately fans out over the IPC/plugin protocol
 * (its complexity is inherent), and it mirrors tauri-mock.ts's plugin:event
 * handling on purpose — both faithfully reimplement the same Tauri seam for
 * different backends, so sharing a helper would couple two independent test
 * doubles. Excluded from fallow's complexity/duplication gates via the root
 * .fallowrc.json (health.ignore / duplicates.ignore).
 */

interface TauriInternals {
  invoke: (
    cmd: string,
    payload?: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  transformCallback: (cb: (data: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  runCallback: (id: number, data: unknown) => void;
  callbacks: Map<number, (data: unknown) => void>;
  metadata?: unknown;
  [key: string]: unknown;
}

function installShimTransport(baseUrl: string): void {
  const win = window as unknown as {
    __TAURI_INTERNALS__?: TauriInternals;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, id: number) => void;
    };
    crypto: Crypto;
  };

  // Callback registry — the same shape Tauri's core expects (transformCallback
  // hands out ids; runCallback fires them).
  const callbacks = new Map<number, (data: unknown) => void>();
  // event name → set of listener callback ids.
  const listeners = new Map<string, Set<number>>();

  function registerCallback(cb: (data: unknown) => void, once = false): number {
    const id = win.crypto.getRandomValues(new Uint32Array(1))[0];
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return cb(data);
    });
    return id;
  }

  function runCallback(id: number, data: unknown): void {
    callbacks.get(id)?.(data);
  }

  function dispatchEvent(event: string, payload: unknown): void {
    const ids = listeners.get(event);
    if (!ids) return;
    for (const id of [...ids]) runCallback(id, { event, id, payload });
  }

  function copyView(view: ArrayBufferView): ArrayBuffer {
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return copy.buffer as ArrayBuffer;
  }

  async function invoke(
    cmd: string,
    payload?: unknown,
    options?: unknown,
  ): Promise<unknown> {
    const args = (payload ?? {}) as Record<string, unknown>;

    // Event plugin: handled locally, never sent to the shim.
    if (cmd === "plugin:event|listen") {
      const event = args.event as string;
      const handler = args.handler as number;
      let ids = listeners.get(event);
      if (!ids) listeners.set(event, (ids = new Set()));
      ids.add(handler);
      return handler;
    }
    if (cmd === "plugin:event|unlisten") {
      listeners.get(args.event as string)?.delete(args.eventId as number);
      return null;
    }
    // Other plugin traffic (store, window, webview, dialog…) is not backed by
    // the shim. Resolve benignly so app boot doesn't reject on it — the smoke
    // exercises fs, not these plugins.
    if (cmd.startsWith("plugin:")) return null;

    // Real command → shim HTTP. text/plain keeps it a CORS "simple request"
    // (no preflight); the shim parses the body as JSON. Raw-body invokes
    // (an ArrayBuffer/TypedArray payload, e.g. write_binary_file) send the
    // bytes with `?raw=1`, and Tauri invoke headers travel percent-encoded
    // in the query — custom request headers would force a CORS preflight
    // the shim doesn't serve.
    const rawBody =
      payload instanceof ArrayBuffer
        ? payload
        : ArrayBuffer.isView(payload)
          ? // Copy into a fresh plain-ArrayBuffer view (fetch's BodyInit
            // rejects possibly-SharedArrayBuffer-backed views at the type
            // level). Test-only path; the copy is fine.
            copyView(payload)
          : null;
    const invokeHeaders = (options as { headers?: Record<string, string> })
      ?.headers;
    const query = rawBody
      ? `?raw=1${
          invokeHeaders
            ? `&headers=${encodeURIComponent(JSON.stringify(invokeHeaders))}`
            : ""
        }`
      : "";
    const res = await fetch(`${baseUrl}/invoke/${cmd}${query}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: rawBody ?? JSON.stringify(args),
    });
    // Raw responses (e.g. read_binary_file) mirror real Tauri: an ArrayBuffer.
    if (res.ok && res.headers.get("content-type") === "application/octet-stream") {
      return await res.arrayBuffer();
    }
    const text = await res.text();
    if (!res.ok) {
      // Non-2xx mirrors a command that returned Result::Err. Real Tauri rejects
      // with the *deserialized payload*, not an Error — code that reads
      // `error.type` or checks `instanceof Error` behaves differently against
      // the two, so wrapping here would make the double lie about the boundary.
      try {
        throw JSON.parse(text);
      } catch (parseFailure) {
        if (parseFailure instanceof SyntaxError) {
          throw new Error(text || `shim invoke ${cmd} failed (${res.status})`);
        }
        throw parseFailure;
      }
    }
    return text ? JSON.parse(text) : null;
  }

  const internals: TauriInternals = {
    invoke,
    transformCallback: registerCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback,
    callbacks,
    // Mock the current window/webview labels so getCurrentWindow()/
    // getCurrentWebview() don't throw during adapter setup.
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
  };
  win.__TAURI_INTERNALS__ = internals;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event, id) => callbacks.delete(id),
  };

  // Connect the event channel. No events are forwarded in the shim's first cut,
  // but the connection is kept so future watcher/agent events can be delivered.
  try {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/events`);
    ws.onmessage = (ev) => {
      try {
        const { event, payload } = JSON.parse(ev.data as string);
        if (typeof event === "string") dispatchEvent(event, payload);
      } catch {
        // Ignore malformed frames.
      }
    };
  } catch {
    // A missing event channel must not break invoke-only flows.
  }
}

if (import.meta.env.VITE_TEST_BACKEND === "shim") {
  const port = import.meta.env.VITE_TEST_BACKEND_PORT ?? "4599";
  installShimTransport(`http://127.0.0.1:${port}`);

  // The pathutil flavor must follow the SHIM HOST's OS, not the browser's
  // user agent — Playwright's "Desktop Chrome" presents a Windows UA even on
  // a mac runner, which bound the win32 flavor and produced backslash paths
  // against a posix backend. The Playwright config passes the host's
  // process.platform through VITE_TEST_HOST_OS; getDesktopOs() reads this
  // override before falling back to UA sniffing.
  const hostOs = import.meta.env.VITE_TEST_HOST_OS as string | undefined;
  if (hostOs) {
    (window as unknown as Record<string, unknown>).__NOTEFIG_DESKTOP_OS__ =
      hostOs === "win32" ? "windows" : hostOs === "darwin" ? "macos" : "linux";
  }

  // eslint-disable-next-line no-console
  console.info(`[shim-transport] installed → http://127.0.0.1:${port}`);
}
