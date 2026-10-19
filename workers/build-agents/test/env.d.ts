// The test Worker's bindings, for `env` from cloudflare:workers in tests.
import type { Env as WorkerEnv } from "../src/config.ts";

declare global {
	namespace Cloudflare {
		interface Env extends WorkerEnv {}
	}
}
