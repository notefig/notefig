# Reference screenshots of the TS app

The GPUI port is checked against the TS app by eye. This folder drives the TS
app's web build (mock agents, no telemetry dialog) with Playwright and saves
screenshots plus accessibility trees in `out/`.

1. Start the TS web build (once; it may already be running on 1420):
   `cd ~/Documents/notefig/packages/desktop && VITE_TELEMETRY_DISABLED=1 VITE_AGENT_MOCK=1 npx vite --port 1420 --strictPort`
2. Run a spec (write your own `<surface>.spec.ts`; `helpers.ts` seeds a demo workspace):
   `cd tools/ref-shots && NODE_PATH=~/Documents/notefig/node_modules ~/Documents/notefig/node_modules/.bin/playwright test -c pw.config.ts <surface>.spec.ts`
3. Read `out/*.png` and `out/*.aria.txt`.

In the e2e page the Mod key is Control (the page reports Win32).
The mock harness (`VITE_AGENT_MOCK=1`) serves agent sessions, so chat,
sessions and prompt widgets can be captured without a real agent.
