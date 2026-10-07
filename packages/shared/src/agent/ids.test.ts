import {
  idTimestamp,
  newEventId,
  newMessageId,
  newTaskId,
  newTurnId,
  newUsageBucketId,
} from "./ids";

describe("agent ids", () => {
  it("prefixes each entity", () => {
    expect(newTaskId()).toMatch(/^task_[0-9a-f]{16}[0-9A-Za-z]{10}$/);
    expect(newTurnId()).toMatch(/^trn_[0-9a-f]{16}[0-9A-Za-z]{10}$/);
    expect(newMessageId()).toMatch(/^msg_[0-9a-f]{16}[0-9A-Za-z]{10}$/);
    expect(newEventId()).toMatch(/^evt_[0-9a-f]{16}[0-9A-Za-z]{10}$/);
  });

  it("ascending ids sort lexicographically in creation order, even within one ms", () => {
    const ids = Array.from({ length: 500 }, () => newMessageId());
    expect([...ids].sort()).toEqual(ids);
  });

  it("descending task ids sort newest-first", () => {
    const first = newTaskId();
    const second = newTaskId();
    expect(second < first).toBe(true);
  });

  it("ascending id timestamps are decodable", () => {
    const before = Date.now();
    const id = newMessageId();
    const after = Date.now();
    const decoded = idTimestamp(id);
    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after);
  });

  it("rejects malformed ids", () => {
    expect(idTimestamp("nounderscore")).toBeUndefined();
    expect(idTimestamp("msg_short")).toBeUndefined();
  });

  it("mints usage bucket ids at the bucket's hour", () => {
    const hour = Date.UTC(2026, 9, 6, 14);
    const id = newUsageBucketId(hour);
    expect(id).toMatch(/^usg_[0-9a-f]{16}[0-9A-Za-z]{10}$/);
    expect(idTimestamp(id)).toBe(hour);
    expect(newUsageBucketId(hour - 3_600_000) < id).toBe(true);
  });

  it("an explicit-time id never disturbs live ordering", () => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      ids.push(newEventId());
      newUsageBucketId(0);
    }
    expect([...ids].sort()).toEqual(ids);
  });
});
