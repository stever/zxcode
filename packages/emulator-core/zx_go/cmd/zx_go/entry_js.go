//go:build js && wasm

package main

import "time"

// wasm entry. Keep the Go runtime alive for the exported js callbacks. A bare
// `select{}` trips the wasm deadlock detector once the imported packages (fyne,
// oto) park their background goroutines, so hold a timer goroutine open — the
// scheduler counts it as future-runnable and the program stays live.
func main() {
	setupWasmExports()
	go func() {
		for {
			time.Sleep(time.Hour)
		}
	}()
	select {}
}
