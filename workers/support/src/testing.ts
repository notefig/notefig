/** Fakes for the Worker's bindings, shared by the tests. */

export function fakeKv() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  return {
    values,
    ttls,
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      values.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
  } as unknown as KVNamespace & { values: Map<string, string>; ttls: Map<string, number | undefined> };
}

export const validFeedback = {
  kind: "bug",
  message: "The sidebar flickers when I rename a file",
  version: "0.0.146",
  os: "macos",
};
