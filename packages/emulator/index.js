// Public API for the shared ZX Spectrum emulator engine (zxplay_go wasm core).
// Consumers mount the emulator with JSSpeccy(container, opts) and drive the
// returned handle (start/reset/openTAPFile/openUrl/...). The engine assets
// (zx.wasm, wasm_exec.js, zx-feeder.worklet.js) are emitted to ./dist by the
// package build and must be served from the consuming app's /dist, matching
// the runtime URL resolution in src/zxgo/GoEmulator.js.
export { JSSpeccy } from './src/JSSpeccy';
export { assetUrl } from './src/zxgo/assetManifest';
