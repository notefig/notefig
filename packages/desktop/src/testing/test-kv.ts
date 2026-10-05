/**
 * A real KV store for tests, over an in-memory SQLite database of its own —
 * each call is a fresh, empty store, so nothing leaks between tests.
 */
import { createKv, type KvApi } from "@/utils/kv-store";
import { createNodeTestDb } from "./node-db";

export function testKv(): KvApi {
  const db = createNodeTestDb();
  return createKv(() => db.get());
}
