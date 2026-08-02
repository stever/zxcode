// Machine-specific on-screen keyboards: the data (where each key sits in the
// machine's photograph and what it does) and the drawing. The apps supply the
// canvas plumbing — see apps/*/src/components/Keyboard.jsx.
export {KEY_ACTIONS, matrixKey} from './keys';
export {LAYOUTS, layoutForMachine, layoutAspect, baseKeyId, keyRects} from './layouts';
export {drawKeyboard, drawKeyPressed, heldKeys} from './render';
