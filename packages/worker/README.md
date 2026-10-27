# @notefig/worker

How the app's Web Workers talk to the main thread: a typed promise API over
`postMessage`, the same in every package.

- **Calling a worker.** The worker serves a plain object of functions with
  `exposeWorkerApi(api)`. The main thread gets a typed proxy from
  `createWorkerClient<typeof api>(worker)`, where every method returns a
  promise. `ready` settles on the worker's handshake. A worker that crashes,
  or doesn't start within the timeout, fails every call with a
  `WorkerRpcError` whose `workerDead` is true, so the caller can start a new
  one.
- **Calling back to the main thread.** Some work needs what only the main
  thread has: Tauri's `invoke` doesn't exist in workers, for example. The
  main thread serves those calls with `serveWorkerHost(worker, api)`, and the
  worker calls them through `createHostClient()`.

The workers themselves live with the code they serve: the markdown codec and
git in `packages/desktop/src/workers/`, speech in `@notefig/dictation`.
