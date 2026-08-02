# On-screen keyboard art

`key*.png` — the 48K's rubber keys, one image per key, laid out on a square
grid by `src/components/Keyboard.jsx`. Descended from JSSpeccy3.

`spectrum-plus.webp`, `spectrum-next.webp` — the ZX Spectrum+ / 128K toastrack
and ZX Spectrum Next keyboards, one photograph each, taken by the project owner
of machines in his own collection and used with his permission. Each is the
whole keyboard: the app draws it once and overlays only the keys being held.
Every key's rectangle within the picture is recorded in
`packages/ui/keyboard/layouts.js`, measured off these images, so a key's hit
area is exactly the key you can see.

Cleaned up before use: the illumination flattened (a large-radius blur is the
lighting across the panel, so dividing by it evens the sheen without touching
each key's own shading), dust removed (small bright blobs that are not part of
a printed legend — a legend is a long, connected stroke), and the room's
reflection taken out of the Next's space bar by patching that stretch of the
bevel with the clean part of the same key. Delivered at 1400px wide, which is
about twice the width the keyboard is ever drawn at.

Both apps serve identical copies of this directory.
