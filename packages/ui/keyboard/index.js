// Machine-specific on-screen keyboards: the data (where each key sits, what it
// prints and what it does) and the drawing. The apps supply the canvas
// plumbing — see apps/*/src/components/Keyboard.jsx.
export {KEY_ACTIONS, matrixKey} from './keys';
export {
    LAYOUTS, KEYBOARD_CHOICES, layoutForMachine, layoutForChoice, layoutAspect, layoutFromKeystr,
    baseKeyId, keyRects,
} from './layouts';
export {legendsFor, GRAPHIC_QUADRANTS} from './legends';
export {PALETTE} from './keycap';
export {RUBBER_PALETTE} from './rubberkey';
export {buildKeyboard, drawKeyboard, drawKeyPressed, heldKeys} from './render';
