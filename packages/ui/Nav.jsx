import React from "react";
import {Menubar} from "primereact/menubar";
import {LanguageSwitcher, SUPPORTED_LANGUAGES, useTranslation} from "@zxplay/i18n";
import "./Nav.scss";

// Width at/below which the menubar collapses to a hamburger. Matches primereact
// Menubar's default breakpoint so our own responsive tweaks (hamburger on the
// right, language folded into the menu) switch in lockstep with the collapse.
const MOBILE_BREAKPOINT = 960;

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

// Shared control deck for both ZX Play apps. Presentational: it owns the brand,
// the language switcher, the styling and the rainbow rule, and renders a
// primereact Menubar so dropdowns / mobile collapse keep working. Each app
// passes its own menu `model` and wiring (navigation, redux) as props, so no
// app-specific state leaks into the shared component.
//
// When collapsed (narrow viewport, or isMobile forced by the caller) the
// hamburger moves to the right and the language picker folds into the menu as a
// submenu instead of sitting in the always-visible end slot.
export function Nav({model, brandTitle = "ZX Play", onBrand, isMobile = false, search = null}) {
    const {t, i18n} = useTranslation();
    const narrow = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const collapsed = isMobile || narrow;

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
    // theme's `@media (max-width: 960px)`, and the caller-forced case (isMobile)
    // by the `.zx-deck--mobile` rules in Nav.scss. The Menubar `breakpoint` prop
    // is unsupported in this primereact version, so it is deliberately not set.
    const showLangInEnd = !collapsed;
    const end = (search || showLangInEnd) ? (
        <div className="zx-deck-end">
            {search}
            {showLangInEnd && <LanguageSwitcher className="zx-lang"/>}
        </div>
    ) : null;

    const classNames = "zx-deck"
        + (isMobile ? " zx-deck--mobile" : "")
        + (collapsed ? " zx-deck--collapsed" : "");

    return (
        <div className={classNames}>
            <Menubar model={menuModel} start={brand} end={end}/>
            <hr className="zx-rule"/>
        </div>
    );
}
