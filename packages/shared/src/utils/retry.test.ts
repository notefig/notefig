import { retry } from "./retry";

describe("retry", () => {
  it("returns the value on the first success without retrying", async () => {
    let calls = 0;
    const outcome = await retry(
      async () => {
        calls += 1;
        return "ok";
      },
      { attempts: 3 },
    );

    expect(outcome).toEqual({ status: "ok", value: "ok" });
    expect(calls).toBe(1);
  });

  it("recovers from transient failures within the attempt budget", async () => {
    let calls = 0;
    const outcome = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return 42;
      },
      { attempts: 5, backoffMs: () => 0 },
    );

    expect(outcome).toEqual({ status: "ok", value: 42 });
    expect(calls).toBe(3);
  });

  it("reports exhaustion with the last error after all attempts fail", async () => {
    let calls = 0;
    const outcome = await retry(
      async () => {
        calls += 1;
        throw new Error(`fail ${calls}`);
      },
      { attempts: 3, backoffMs: () => 0 },
    );

    expect(calls).toBe(3);
    expect(outcome.status).toBe("exhausted");
    expect((outcome as { error: Error }).error).toEqual(new Error("fail 3"));
  });

  it("aborts before an attempt when aborted() turns true, without consuming it", async () => {
    let calls = 0;
    let stop = false;
    const outcome = await retry(
      async () => {
        calls += 1;
        stop = true; // cancel arrives during the first attempt
        throw new Error("transient");
      },
      { attempts: 5, backoffMs: () => 0, aborted: () => stop },
    );

    expect(outcome).toEqual({ status: "aborted" });
    expect(calls).toBe(1); // the second attempt was never made
  });

  it("waits the backoff the option specifies between attempts", async () => {
    const waits: number[] = [];
    const backoffMs = (attempt: number) => {
      waits.push(attempt);
      return 0;
    };
    await retry(
      async () => {
        throw new Error("always");
      },
      { attempts: 3, backoffMs },
    );

    // Backoff runs after each failed attempt except the last (no wait when
    // there is nothing left to retry).
    expect(waits).toEqual([0, 1]);
  });
});
