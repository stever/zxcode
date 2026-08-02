// Machine-specific on-screen keyboards: the data (where each key sits, what it
// prints and what it does) and the drawing. The apps supply the canvas
// plumbing — see apps/*/src/components/Keyboard.jsx.
export {KEY_ACTIONS, matrixKey} from './keys';
export {LAYOUTS, layoutForMachine, layoutAspect, baseKeyId, keyRects} from './layouts';
export {legendsFor, GRAPHIC_QUADRANTS} from './legends';
export {PALETTES} from './keycap';
export {buildKeyboard, drawKeyboard, drawKeyPressed, heldKeys} from './render';
