import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createCore } from "@notefig/core";
import {
  projectSettingsModule,
  projectSettingsQueryKey,
} from "@/modules/project-settings";

describe("projectSettingsModule", () => {
  it("drops a workspace's cached settings when the watcher reports its metrists.json", () => {
    const queryClient = new QueryClient();
    const core = createCore({
      // The module reads nothing from the platform at boot; it only has to exist.
      services: { queryClient, platform: {} } as never,
      modules: [projectSettingsModule],
    });
    core.boot();
    const key = projectSettingsQueryKey("/ws");
    queryClient.setQueryData(key, { settings: {} });

    core.hooks.emit("files:changed", {
      workspacePath: "/ws",
      paths: ["/ws/a.md"],
    });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);

    core.hooks.emit("files:changed", {
      workspacePath: "/ws",
      paths: ["/ws/metrists.json"],
    });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    void core.dispose();
  });
});
