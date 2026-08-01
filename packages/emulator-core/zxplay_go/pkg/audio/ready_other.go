//go:build !js

package audio

// waitAudioReady blocks until oto's audio device is ready. On native builds this
// avoids dropping the first samples, and blocking here is harmless.
func waitAudioReady(ready <-chan struct{}) { <-ready }
