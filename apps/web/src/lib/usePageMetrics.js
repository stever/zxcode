import {useLayoutEffect, useState} from "react";

// The layout arithmetic in ./layout.js decides how big the emulator and the
// editor may be. What it cannot do is guess the chrome around them: the nav
// collapses, the toolbar wraps to a second row at a width that differs per
// locale, the logged-out notice runs to three lines or five, the home page
// keeps a Run button under its editor, and the tab strip is a different height
// again. Every one of those was a constant once, and the page scrolled by
// however much the constant was wrong.
//
// So the page measures where its panels actually START and what actually sits
// under them, and hands those to the arithmetic. None of these measurements
// depends on the sizes they go on to decide, so there is no feedback loop:
// the emulator's top is fixed by the chrome above it, and the gap below the
// editor is the same whatever height the editor is given.

// Measure after every render rather than on a dependency list: what moves these
// is layout (a wrapped toolbar, a collapsed nav, a tab switch), which no
// dependency array can name. The state only updates when the number changes, so
// this settles in one extra pass instead of looping.
function useMeasure(read) {
    const [value, setValue] = useState(0);

    useLayoutEffect(() => {
        const measure = () => {
            const next = read();
            if (next !== null) setValue((current) => (current === next ? current : next));
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    });

    return value;
}

/**
 * The distance from the top of the viewport to the top of an element: where a
 * panel starts, and so how much height is left for it.
 * @param {Object} ref
 * @returns {Number}
 */
export function useElementTop(ref) {
    return useMeasure(() => {
        const element = ref.current;
        if (!element) return null;
        return Math.round(element.getBoundingClientRect().top);
    });
}

/**
 * The height an element costs the page, its vertical margins included — a
 * bounding box leaves those out, and they are as much a part of the space it
 * takes as its content.
 * @param {Object} ref
 * @returns {Number}
 */
export function useElementHeight(ref) {
    return useMeasure(() => {
        const element = ref.current;
        if (!element) return null;
        const style = window.getComputedStyle(element);
        const margins = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        // Round up: a fractional height left unaccounted for is exactly the
        // one-pixel scrollbar this measurement exists to prevent.
        return Math.ceil(element.getBoundingClientRect().height + margins);
    });
}

/**
 * Everything in `containerSel` that is NOT the element matched by `targetSel`:
 * the tab strip above the editor, and below it the home page's Run button and
 * divider, or the project page's toolbar. Measuring the difference rather than
 * naming the parts keeps this true however those parts change.
 *
 * The container must be CONTENT-SIZED for that difference to mean anything. It
 * is deliberately the tab view rather than the column around it: the grid
 * stretches the column to its sibling's height, so column-minus-editor would
 * grow by exactly what the editor gave up and chase itself forever.
 *
 * @param {Object} rootRef
 * @param {String} containerSel
 * @param {String} targetSel
 * @returns {Number}
 */
export function useChromeAround(rootRef, containerSel, targetSel) {
    return useMeasure(() => {
        const root = rootRef.current;
        const container = root?.querySelector(containerSel);
        const target = container?.querySelector(targetSel);
        // A tab showing something other than the editor has no CodeMirror to
        // measure; keeping the last answer is right, since the editor is not on
        // screen to be sized.
        if (!container || !target) return null;
        return Math.round(
            container.getBoundingClientRect().height - target.getBoundingClientRect().height);
    });
}
