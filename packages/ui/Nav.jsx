import React from "react";
import {Menubar} from "primereact/menubar";
import {LanguageSwitcher} from "@zxplay/i18n";
import "./Nav.scss";

// Shared control deck for both ZX Play apps. Presentational: it owns the brand,
// the language switcher, the styling and the rainbow rule, and renders a
// primereact Menubar so dropdowns / mobile collapse keep working. Each app
// passes its own menu `model` and wiring (navigation, redux) as props, so no
// app-specific state leaks into the shared component.
export function Nav({model, brandTitle = "ZX Play", onBrand, isMobile = false, search = null}) {
    const brand = (
        <button type="button" className="zx-brand" onClick={onBrand} aria-label={brandTitle}>
            <span className="zx-mark" aria-hidden="true"><i/></span>
            <span className="zx-wordmark">{brandTitle}</span>
        </button>
    );

    const end = (
        <div className="zx-deck-end">
            {search}
            <LanguageSwitcher className="zx-lang"/>
        </div>
    );

    return (
        <div className={"zx-deck" + (isMobile ? " zx-deck--mobile" : "")}>
            <Menubar model={model} start={brand} end={end}/>
            <hr className="zx-rule"/>
        </div>
    );
}
