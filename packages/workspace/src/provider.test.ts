import { createProvider } from "./provider";

describe("createProvider", () => {
  it("resolves through the fallback until an implementation is registered", () => {
    const provider = createProvider<[string], number>(() => -1);
    expect(provider.resolve("x")).toBe(-1);

    provider.register((id) => id.length);
    expect(provider.resolve("abc")).toBe(3);
  });

  it("registering again replaces the previous implementation outright", () => {
    const provider = createProvider<[], number>(() => 0);
    provider.register(() => 1);
    provider.register(() => 2);
    expect(provider.resolve()).toBe(2);
  });
});
