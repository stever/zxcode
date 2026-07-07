//go:build js

package main

// showGUIError is a no-op in the browser build: there is no fyne window
// and callers already log the error via slog.
func (e *emulator) showGUIError(error) {}
