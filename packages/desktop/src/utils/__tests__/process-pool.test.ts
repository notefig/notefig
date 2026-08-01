import { describe, it, expect } from "vitest";
import { processPool } from "../process-pool";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("processPool", () => {
  it("processes all items from a sync iterable", async () => {
    const items = [1, 2, 3];
    const results = await processPool(items, async (n) => [n * 10], {
      concurrency: 2,
    });
    expect(results.succeeded.sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect(results.errors).toEqual([]);
  });

  it("processes all items from an async iterable", async () => {
    async function* gen() {
      yield "a";
      yield "b";
      yield "c";
    }
    const results = await processPool(gen(), async (s) => [s.toUpperCase()], {
      concurrency: 2,
    });
    expect(results.succeeded.sort()).toEqual(["A", "B", "C"]);
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let current = 0;

    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    await processPool(
      items,
      async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await delay(20);
        current--;
        return [];
      },
      { concurrency: 3 },
    );

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("stops launching new workers when shouldContinue returns false", async () => {
    const processed: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    const results = await processPool(
      items,
      async (n) => {
        processed.push(n);
        await delay(5);
        return [n];
      },
      {
        concurrency: 1,
        shouldContinue: (r) => r.length < 3,
      },
    );

    // With concurrency 1, should process exactly 3 then stop
    expect(processed.length).toBe(3);
    expect(results.succeeded.length).toBe(3);
  });

  it("allows in-flight workers to finish when shouldContinue returns false", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    const results = await processPool(
      items,
      async (n) => {
        await delay(10);
        return [n];
      },
      {
        concurrency: 3,
        shouldContinue: (r) => r.length < 2,
      },
    );

    // May slightly exceed 2 since in-flight workers finish
    expect(results.succeeded.length).toBeGreaterThanOrEqual(2);
    // But should not process all 8 items
    expect(results.succeeded.length).toBeLessThanOrEqual(5);
  });

  it("processor returning multiple results flattens them", async () => {
    const results = await processPool(
      ["hello world", "foo bar baz"],
      async (s) => s.split(" "),
      { concurrency: 2 },
    );
    expect(results.succeeded.sort()).toEqual([
      "bar",
      "baz",
      "foo",
      "hello",
      "world",
    ]);
  });

  it("collects errors from processor", async () => {
    const items = [1, 2, 3];
    const results = await processPool(
      items,
      async (n) => {
        if (n === 2) throw new Error("fail");
        return [n];
      },
      { concurrency: 2 },
    );
    expect(results.succeeded.sort((a, b) => a - b)).toEqual([1, 3]);
    expect(results.errors).toHaveLength(1);
    expect(results.errors[0].message).toBe("fail");
  });

  it("handles empty iterable", async () => {
    const results = await processPool([], async () => [1], { concurrency: 2 });
    expect(results.succeeded).toEqual([]);
  });

  it("handles empty async iterable", async () => {
    async function* empty() {
      // yields nothing
    }
    const results = await processPool(empty(), async () => [1], {
      concurrency: 2,
    });
    expect(results.succeeded).toEqual([]);
  });

  it("works with concurrency of 1 (sequential)", async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    await processPool(
      items,
      async (n) => {
        order.push(n);
        await delay(5);
        return [n];
      },
      { concurrency: 1 },
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it("stops immediately when shouldContinue starts as false", async () => {
    const processed: number[] = [];
    const results = await processPool(
      [1, 2, 3],
      async (n) => {
        processed.push(n);
        return [n];
      },
      {
        concurrency: 2,
        shouldContinue: () => false,
      },
    );
    expect(processed).toEqual([]);
    expect(results.succeeded).toEqual([]);
  });
});
