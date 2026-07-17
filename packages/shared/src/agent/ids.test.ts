import {
  idTimestamp,
  newEventId,
  newMessageId,
  newTaskId,
  newTurnId,
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
});
