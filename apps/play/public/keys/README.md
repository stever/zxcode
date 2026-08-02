# On-screen keyboard art

`key*.png` — the 48K's rubber keys, one image per key, laid out on a square
grid by `src/components/Keyboard.jsx`. Descended from JSSpeccy3.

The ZX Spectrum+ / 128K toastrack and ZX Spectrum Next keyboards are not
images: they are DRAWN, by `packages/ui/keyboard`, from photographs of both
machines taken by the project owner. Every key rectangle, every legend and the
shape of the moulding were transcribed from those photographs — the two
machines turn out to lay their keys on the same grid, 13.5 key widths across
and five rows down, with every key a whole or a quarter of a key width — and
drawing rather than compositing keeps the legends crisp at any size, drops
~300 KB of image, and leaves neither dust nor reflections on the keys.

Both apps serve identical copies of this directory.
