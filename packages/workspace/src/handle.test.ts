import { createHandle } from "./handle";

describe("createHandle", () => {
  it("spreads identity fields and computes methods from the handle itself", () => {
    const h = createHandle(
      { id: "a", n: 2 },
      {
        doubled: (self) => self.n * 2,
      },
    );
    expect(h.id).toBe("a");
    expect(h.n).toBe(2);
    expect(h.doubled()).toBe(4);
  });

  it("recomputes on every call — no cached state", () => {
    let calls = 0;
    const h = createHandle({ id: "a" }, { count: () => ++calls });
    expect(h.count()).toBe(1);
    expect(h.count()).toBe(2);
    expect(h.count()).toBe(3);
  });

});
