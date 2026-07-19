import { createRegistry } from "./registry";

describe("createRegistry", () => {
  it("registers, reads, and unregisters by id", () => {
    const registry = createRegistry<{ value: number }>();
    expect(registry.get("a")).toBeUndefined();
    expect(registry.has("a")).toBe(false);

    registry.register("a", { value: 1 });
    expect(registry.get("a")).toEqual({ value: 1 });
    expect(registry.has("a")).toBe(true);

    registry.unregister("a");
    expect(registry.get("a")).toBeUndefined();
    expect(registry.has("a")).toBe(false);
  });

  it("clears all entries", () => {
    const registry = createRegistry<number>();
    registry.register("a", 1);
    registry.register("b", 2);
    registry.clear();
    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")).toBeUndefined();
  });
});
