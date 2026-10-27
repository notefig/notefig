// The worker imports onnxruntime's wasm as a URL (Vite's `?url`): every
// consumer of this package builds it with Vite.
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
