import { describe, expect, it } from "vitest";
import { createBuildQueue } from "./build-queue";
import { memoryStorage } from "./testing";

function setup() {
  let now = 1_000;
  let id = 0;
  const queue = createBuildQueue(memoryStorage(), { now: () => now++, newId: () => `b${++id}` });
  const request = (issue: string) => queue.request({ issueId: issue, identifier: `MET-${issue}` });
  return { queue, request };
}

describe("createBuildQueue", () => {
  it("starts the first build and queues the rest in order", async () => {
    const { queue, request } = setup();
    expect(await request("1")).toMatchObject({ kind: "start", build: { id: "b1", status: "running" } });
    expect(await request("2")).toMatchObject({ kind: "queued", ahead: 0, running: { identifier: "MET-1" } });
    expect(await request("3")).toMatchObject({ kind: "queued", ahead: 1 });

    expect(await queue.finish("b1")).toMatchObject({ next: { id: "b2", status: "running" } });
    expect(await queue.finish("b2")).toMatchObject({ next: { id: "b3" } });
    expect(await queue.finish("b3")).toEqual({ finished: expect.objectContaining({ id: "b3" }) });
    expect(await queue.running()).toBeUndefined();
  });

  it("refuses a second build for an issue that has one queued or running", async () => {
    const { request } = setup();
    await request("1");
    await request("2");
    expect(await request("1")).toMatchObject({ kind: "already", build: { status: "running" } });
    expect(await request("2")).toMatchObject({ kind: "already", build: { status: "queued" } });
  });

  it("lets an issue build again once its build finished", async () => {
    const { queue, request } = setup();
    await request("1");
    await queue.finish("b1");
    expect(await request("1")).toMatchObject({ kind: "start" });
  });

  it("drops a queued build without starting another", async () => {
    const { queue, request } = setup();
    await request("1");
    await request("2");
    expect(await queue.finish("b2")).toEqual({ finished: expect.objectContaining({ id: "b2" }) });
    expect(await queue.finish("b1")).toEqual({ finished: expect.objectContaining({ id: "b1" }) });
  });

  it("ignores a result for a build it doesn't know", async () => {
    const { queue } = setup();
    expect(await queue.finish("nope")).toEqual({});
  });
});
