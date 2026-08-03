import React from "react";
import {Menubar} from "primereact/menubar";
import {LanguageSwitcher, SUPPORTED_LANGUAGES, useTranslation} from "@zxplay/i18n";
import "./Nav.scss";

// Width at/below which the menubar collapses to a hamburger. Matches primereact
// Menubar's default breakpoint so our own responsive tweaks (hamburger on the
// right, language folded into the menu) switch in lockstep with the collapse.
const MOBILE_BREAKPOINT = 960;

// Slack (px) the bar must gain back before it expands again. Absorbs a page
// scrollbar appearing or disappearing as the collapse changes the page height,
// which would otherwise flip the bar between its two states on one width.
const EXPAND_SLACK = 24;

function useMediaQuery(query) {
    const get = () => (typeof window !== 'undefined' && window.matchMedia)
        ? window.matchMedia(query).matches
        : false;
    const [matches, setMatches] = React.useState(get);
    React.useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined;
        const mql = window.matchMedia(query);
        const onChange = () => setMatches(mql.matches);
        onChange();
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [query]);
    return matches;
}

/**
 * Collapse the bar to its hamburger at the width where its items would wrap to
 * a second row. A second row steals height from the page below and reads as a
 * mistake, and no fixed breakpoint can find it: the labels are translated into
 * eleven locales, and the German and Spanish menus are far wider than the
 * English ones.
 *
 * The measurement is the width ONE ROW needs. It is retaken whenever the bar is
 * expanded, and only held while collapsed — there the items are a vertical
 * dropdown and cannot be measured. Comparing the live width against a number
 * that does not itself depend on the answer is monotone, so the two states
 * cannot oscillate the way a "did it wrap?" test would.
 *
 * @param {Object} deckRef the deck root element's ref
 * @param {String} signature the item labels; new labels mean a new measurement
 * @param {Boolean} enabled false when the bar is collapsed for another reason,
 *                  which is also when the measurement would be meaningless
 * @returns {Boolean}
 */
function useOverflowCollapse(deckRef, signature, enabled) {
    const [overflowed, setOverflowed] = React.useState(false);
    const neededRef = React.useRef(null);
    // Mirrors the state for the observer callback, which closes over the
    // render it was created in and must not re-subscribe on every flip.
    const stateRef = React.useRef(false);

    React.useEffect(() => {
        neededRef.current = null; // new labels, new widths
        setOverflowed(false);     // expand so the next measurement can see them
        stateRef.current = false;
    }, [signature]);

    React.useLayoutEffect(() => {
        const bar = deckRef.current?.querySelector('.p-menubar');
        const list = deckRef.current?.querySelector('.p-menubar-root-list');
        if (!enabled || !bar || !list) return undefined;

        const measure = () => {
            const barW = bar.clientWidth;
            if (!barW) return; // not laid out yet
            if (!stateRef.current) {
                // Expanded, so the items can be measured. Their own widths plus
                // everything around them (brand, language slot, gaps) is the bar
                // width one row needs: the list is content-sized until it wraps,
                // at which point it reports the narrower width it was held to
                // and the difference is exactly the shortfall. The root list
                // carries no gap of its own, so the sum is exact.
                //
                // Re-measured every time rather than cached, because the first
                // measurement lands before the webfonts do and the items are
                // narrower in the fallback face — cache that and the bar would
                // wrap for good once the real face arrived.
                const items = Array.from(list.children);
                if (!items.length) return;
                const itemsW = items.reduce((sum, li) => sum + li.offsetWidth, 0);
                neededRef.current = itemsW + (barW - list.clientWidth);
            }
            // Collapsed, the items are a vertical dropdown and cannot be
            // measured, so the last expanded measurement is what decides when to
            // come back — plus the slack that stops the two states oscillating.
            const needed = neededRef.current + (stateRef.current ? EXPAND_SLACK : 0);
            const next = barW < needed;
            if (next !== stateRef.current) {
                stateRef.current = next;
                setOverflowed(next);
            }
        };

        measure();
        // The item widths move when the face they are set in arrives.
        if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
        if (typeof ResizeObserver === 'undefined') return undefined;
        // Both boxes: the bar for the width it has, the list for the width its
        // items want (a locale change restyles them in place).
        const observer = new ResizeObserver(measure);
        observer.observe(bar);
        observer.observe(list);
        return () => observer.disconnect();
    }, [deckRef, enabled, signature]);

    return enabled && overflowed;
}

// Shared control deck for both ZX Play apps. Presentational: it owns the brand,
// the language switcher, the styling and the rainbow rule, and renders a
// primereact Menubar so dropdowns / mobile collapse keep working. Each app
// passes its own menu `model` and wiring (navigation, redux) as props, so no
// app-specific state leaks into the shared component.
//
// When collapsed (narrow viewport, isMobile forced by the caller, or the items
// no longer fitting one row) the hamburger moves to the right and the language
// picker folds into the menu as a submenu instead of sitting in the
// always-visible end slot.
export function Nav({model, brandTitle = "ZX Play", onBrand, isMobile = false, search = null}) {
    const {t, i18n} = useTranslation();
    const deckRef = React.useRef(null);
    const narrow = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    // Below the breakpoint, or when the caller forces it, the bar is already a
    // hamburger and there is nothing to measure. Above it, measure: the item
    // labels decide where one row stops fitting, and they vary by locale.
    const labels = (model || []).map((item) => item.label).join('');
    const overflowed = useOverflowCollapse(deckRef, labels, !isMobile && !narrow);
    // Forced collapse needs the class: primereact's prebuilt theme only reveals
    // the hamburger under its own `@media (max-width: 960px)`, so above that
    // width .zx-deck--mobile is what makes the collapse real.
    const forced = isMobile || overflowed;
    const collapsed = forced || narrow;

    const brand = (
        <button type="button" className="zx-brand" onClick={onBrand} aria-label={brandTitle}>
            <span className="zx-mark" aria-hidden="true"><i/></span>
            <span className="zx-wordmark">{brandTitle}</span>
        </button>
    );

    const activeLang = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
    const languageItem = {
        label: t('language'),
        icon: 'pi pi-fw pi-globe',
        items: SUPPORTED_LANGUAGES.map((l) => ({
            label: l.label,
            icon: l.code === activeLang ? 'pi pi-fw pi-check' : 'pi pi-fw',
            command: () => i18n.changeLanguage(l.code),
        })),
    };

    const menuModel = collapsed ? [...(model || []), languageItem] : model;

    // Collapse is driven by CSS, not primereact: the natural narrow case by the
    // theme's `@media (max-width: 960px)`, and the two forced cases (isMobile,
    // and the items outgrowing one row) by the `.zx-deck--mobile` rules in
    // Nav.scss. The Menubar `breakpoint` prop is unsupported in this primereact
    // version, so it is deliberately not set.
    const showLangInEnd = !collapsed;
    const end = (search || showLangInEnd) ? (
        <div className="zx-deck-end">
            {search}
            {showLangInEnd && <LanguageSwitcher className="zx-lang"/>}
        </div>
    ) : null;

    const classNames = "zx-deck"
        + (forced ? " zx-deck--mobile" : "")
        + (collapsed ? " zx-deck--collapsed" : "");

    return (
        <div className={classNames} ref={deckRef}>
            <Menubar model={menuModel} start={brand} end={end}/>
            <hr className="zx-rule"/>
        </div>
    );
}
