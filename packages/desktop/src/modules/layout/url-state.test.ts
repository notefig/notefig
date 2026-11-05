import { describe, expect, it, vi } from "vitest";
import { urlStateFromRouter } from "./layout";

/** A data router's surface, navigating synchronously like one with no loaders. */
function fakeRouter(search = "", pathname = "/") {
  const listeners = new Set<() => void>();
  const navigations: { search: string; replace: boolean }[] = [];
  const router = {
    state: { location: { pathname, search } },
    navigate: vi.fn(
      async (to: { search?: string; pathname?: string }, options?: { replace?: boolean }) => {
        router.state = {
          location: {
            pathname: to.pathname ?? router.state.location.pathname,
            search: to.search ?? "",
          },
        };
        navigations.push({ search: to.search ?? "", replace: !!options?.replace });
        for (const listener of [...listeners]) listener();
      },
    ),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { router, navigations };
}

/** A deferral the test runs by hand. */
function manualDefer() {
  const tasks = new Set<() => void>();
  return {
    defer: (task: () => void) => {
      tasks.add(task);
      return () => tasks.delete(task);
    },
    run: () => {
      const pending = [...tasks];
      tasks.clear();
      for (const task of pending) task();
    },
  };
}

describe("urlStateFromRouter", () => {
  it("updates in memory at once and tells the router only after paint", () => {
    const { router, navigations } = fakeRouter();
    const paint = manualDefer();
    const url = urlStateFromRouter(router, paint.defer);
    const heard: string[] = [];
    url.subscribe(() => heard.push(url.search()));

    url.setSearch("?layout=a");
    expect(url.search()).toBe("?layout=a");
    expect(heard).toEqual(["?layout=a"]);
    expect(navigations).toEqual([]);

    paint.run();
    expect(navigations).toEqual([{ search: "?layout=a", replace: false }]);
    // The router echoing our own mirror is not a change.
    expect(heard).toEqual(["?layout=a"]);
  });

  it("mirrors a burst of writes once, pushing if any of them pushed", () => {
    const { router, navigations } = fakeRouter();
    const paint = manualDefer();
    const url = urlStateFromRouter(router, paint.defer);

    url.setSearch("?a", { replace: true });
    url.setSearch("?b");
    url.setSearch("?c", { replace: true });
    paint.run();
    expect(navigations).toEqual([{ search: "?c", replace: false }]);

    url.setSearch("?d", { replace: true });
    paint.run();
    expect(navigations.at(-1)).toEqual({ search: "?d", replace: true });
  });

  it("skips the mirror when the state came back to the router's URL", () => {
    const { router, navigations } = fakeRouter("?x");
    const paint = manualDefer();
    const url = urlStateFromRouter(router, paint.defer);
    url.setSearch("?y");
    url.setSearch("?x");
    paint.run();
    expect(navigations).toEqual([]);
  });

  it("adopts a navigation the router makes itself, dropping a pending mirror", async () => {
    const { router, navigations } = fakeRouter("?start");
    const paint = manualDefer();
    const url = urlStateFromRouter(router, paint.defer);
    const heard: string[] = [];
    url.subscribe(() => heard.push(url.search()));

    url.setSearch("?mine");
    // Back/forward, or a router link, lands before the mirror ran.
    await router.navigate({ search: "?theirs" });
    expect(url.search()).toBe("?theirs");
    expect(heard).toEqual(["?mine", "?theirs"]);

    paint.run();
    expect(navigations.map((n) => n.search)).toEqual(["?theirs"]);
  });

  it("does not take a late echo of an older mirror for a navigation", async () => {
    const { router } = fakeRouter();
    const paint = manualDefer();
    // A router whose navigation lands a tick late.
    const navigate = router.navigate;
    let release: () => void = () => {};
    router.navigate = vi.fn((to, options) => {
      return new Promise<void>((resolve) => {
        release = () => void navigate(to, options).then(resolve);
      });
    }) as typeof router.navigate;
    const url = urlStateFromRouter(router, paint.defer);

    url.setSearch("?one");
    paint.run();
    url.setSearch("?two");
    release();
    await Promise.resolve();
    expect(url.search()).toBe("?two");
  });

  it("tells listeners when the path changes", async () => {
    const { router } = fakeRouter("", "/pair");
    const url = urlStateFromRouter(router, manualDefer().defer);
    const listener = vi.fn();
    url.subscribe(listener);
    await router.navigate({ pathname: "/", search: "" });
    expect(url.pathname()).toBe("/");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
