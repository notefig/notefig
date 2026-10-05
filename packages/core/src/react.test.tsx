import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "./create-core";
import { defineModule } from "./define-module";
import { CoreProvider, useWorkspaceModule } from "./react";

declare module "./types" {
  interface WorkspaceModules {
    "r-notes": { label: string };
  }
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

describe("useWorkspaceModule", () => {
  it("re-renders as the workspace opens and closes", async () => {
    const notes = defineModule({
      name: "r-notes",
      workspace: {
        create: (ctx) => ({ label: `notes for ${ctx.workspace.path}` }),
      },
    });
    const core = createCore({ services: {}, modules: [notes] });

    const Probe = () => {
      const instance = useWorkspaceModule("/ws", "r-notes");
      return <span>{instance?.label ?? "closed"}</span>;
    };

    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CoreProvider core={core}>
          <Probe />
        </CoreProvider>,
      );
    });
    expect(container.textContent).toBe("closed");

    await act(() => core.workspace("/ws").open());
    expect(container.textContent).toBe("notes for /ws");

    await act(() => core.workspace("/ws").close());
    expect(container.textContent).toBe("closed");

    await act(async () => root.unmount());
  });
});
