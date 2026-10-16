import { DurableObject } from "cloudflare:workers";
import { createBuildQueue, type BuildRequest } from "./build-queue";
import {
  createBuildService,
  type BuildQueueRpc,
  type BuildResult,
  type BuildService,
} from "./builds";
import { githubFor, linearFor, type Env } from "./env";

/**
 * The service's one build queue (`idFromName("builds")`). Calls run one at
 * a time, so two requests can't both start. An alarm set for the running
 * build's deadline gives up on it if its result never arrives.
 */
export class BuildQueueObject extends DurableObject<Env> implements BuildQueueRpc {
  #builds: BuildService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#builds = createBuildService({
      queue: createBuildQueue(ctx.storage),
      linear: linearFor(env),
      github: githubFor(env),
      warn: (message, error) => console.warn(message, error),
    });
  }

  async request(request: BuildRequest) {
    const result = await this.#builds.request(request);
    await this.#scheduleDeadline();
    return result;
  }

  async report(result: BuildResult) {
    const known = await this.#builds.report(result);
    await this.#scheduleDeadline();
    return known;
  }

  async alarm() {
    await this.#builds.expire();
    await this.#scheduleDeadline();
  }

  async #scheduleDeadline() {
    const deadline = await this.#builds.deadline();
    if (deadline === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(deadline);
  }
}
