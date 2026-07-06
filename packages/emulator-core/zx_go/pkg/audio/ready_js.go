//go:build js

package audio

// waitAudioReady must NOT block on js/wasm: oto's readiness only resolves once
// the JS event loop turns, but this runs inside emulator construction that the
// caller drives from a js callback path. oto players created before "ready"
// simply stay silent until the Web Audio context runs (after a user gesture),
// so drain the channel in the background and return immediately.
func waitAudioReady(ready <-chan struct{}) { go func() { <-ready }() }
