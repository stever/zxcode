// Public API for the shared ZX Spectrum emulator engine.
// Consumers mount the emulator with JSSpeccy(container, opts) and drive the
// returned handle (start/reset/openTAPFile/openUrl/...). The worker bundle and
// WASM core are emitted to ./dist by the package build and must be served from
// the consuming app's /dist (worker) and resolvable relative to its main
// script (wasm), matching the runtime URL resolution in Emulator.js.
export { JSSpeccy } from './src/JSSpeccy';
