# @notefig/dictation

Push-to-talk dictation, on a speech model that runs on the device. Nothing
here talks to a server.

- **The service**: `createDictation(deps)` in [`src/dictation.ts`](src/dictation.ts).
  It follows the hold key and owns the microphone. It cuts speech into
  phrases at pauses ([`src/segmenter.ts`](src/segmenter.ts)) and streams live
  guesses into whichever editor has focus.
- **The editor contract**: [`src/target.ts`](src/target.ts). Editors offer
  themselves as targets, and `fitDictation` fits the text to the words around
  the caret. The Tiptap implementation is `dictationExtension` in
  `@notefig/widgets`.
- **The engine** ([`src/engine/`](src/engine)): `createWorkerEngine(modelUrl)`
  runs Parakeet TDT-CTC 110M with onnxruntime-web in a worker of its own,
  reached through `@notefig/worker`. It
  computes NeMo log-mel features, decodes them with greedy CTC, and checks the
  bundled model as it loads it.

The app wires it up in `packages/desktop/src/modules/dictation/`: the core
module, the user's settings, and where the model is served from.
`packages/desktop/scripts/fetch-dictation-model.mjs` puts the model in the
bundle.
