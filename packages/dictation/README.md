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
- **The engine** (`@notefig/dictation/engine`): NeMo log-mel features, greedy
  CTC decoding, and the bundled model's checked loader. These are what a
  worker needs to run Parakeet TDT-CTC 110M with onnxruntime-web.

The app wires it up in `packages/desktop/src/modules/dictation/` (the core
module, the worker and the settings). `packages/desktop/scripts/fetch-dictation-model.mjs`
puts the model in the bundle.
