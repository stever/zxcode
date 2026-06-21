import React from "react";
import {Link} from "react-router-dom";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {useTranslation, Trans} from "@zxplay/i18n";
import Constants, {sep} from "../constants";

export default function AboutPage() {
    const {t} = useTranslation();
    return (
        <Titled title={(s) => `${t("nav.aboutThisSite")} ${sep} ${s}`}>
            <Card className="m-2">
                <h1>{t("nav.aboutThisSite")}</h1>
                <p>
                    <Trans
                        i18nKey="about.intro1"
                        components={{srcLink: <a href="https://github.com/stever/zxcode" target="_blank" rel="noreferrer"/>}}
                    />
                </p>
                <p>
                    <Trans
                        i18nKey="about.intro2"
                        components={{zxplayLink: <a href="https://zxplay.org/" target="_blank" rel="noreferrer"/>}}
                    />
                </p>
                <p>
                    <Trans
                        i18nKey="about.legal"
                        components={{
                            privacyLink: <Link to="/privacy-policy"/>,
                            termsLink: <Link to="/terms-of-use"/>,
                        }}
                    />
                </p>
                <h2>{t("about.createProjects")}</h2>
                <p>
                    {t("about.registeredUsers")}
                </p>
                <p>
                    {t("about.createAccount")}
                </p>
                <h2>{t("acknowledgements")}</h2>
                <p>
                    {t("about.acknowledgementsIntro")}
                </p>
                <ul>
                    <li>
                        <a href="https://github.com/gasman/jsspeccy3" target="_blank">JSSpeccy3</a>{' '}
                        <a href="https://github.com/dcrespo3d/jsspeccy3-mobile" target="_blank">JSSpeccy3-mobile</a>.
                        These are licensed under terms of The GPL version 3 - see{' '}
                        <a href="https://github.com/gasman/jsspeccy3/blob/main/COPYING" target="_blank">COPYING</a>.
                    </li>
                    <li>
                        <a href="https://pasmo.speccy.org/" target="_blank">Pasmo</a> by Julián Albo García, alias "NotFound".
                        Licensed under terms of The GPL version 3 - see{' '}
                        <a href="https://github.com/stever/emscripten-pasmo/blob/main/COPYING" target="_blank">COPYING</a>.
                    </li>
                    <li>
                        <a href="https://github.com/stever/emscripten-zmakebas" target="_blank">zmakebas</a> by Russell Marks.
                        This tool is public domain.
                    </li>
                    <li>
                        <a href="https://github.com/sehugg/8bitworkshop" target="_blank">8bitworkshop</a> by
                        Steven Hugg. Licensed under terms of The GPL version 3 - see{' '}
                        <a href="https://github.com/sehugg/8bitworkshop/blob/master/LICENSE" target="_blank">LICENSE</a>.
                    </li>
                    {Constants.isDev &&
                        <>
                            <li>
                                <a href="https://github.com/boriel/zxbasic" target="_blank">Boriel ZX BASIC</a> by Jose Rodriguez.
                                Licensed under terms of The GPL version 3 - see{' '}
                                <a href="https://github.com/boriel/zxbasic/blob/master/LICENSE.txt" target="_blank">LICENSE</a>.
                            </li>
                            <li>
                                <a href="https://z88dk.org/" target="_blank">Z88DK</a> by various.
                                Licensed under terms of The Clarified Artistic License - see{' '}
                                <a href="https://github.com/z88dk/z88dk/wiki/license" target="_blank">LICENSE</a>.
                            </li>
                        </>
                    }
                    <li>
                        <a href="https://github.com/primefaces/primereact" target="_blank">PrimeReact</a> by
                        PrimeTek. Licensed under terms of The MIT License - see{' '}
                        <a href="https://github.com/primefaces/primereact/blob/master/LICENSE.md" target="_blank">LICENSE</a>.
                    </li>
                </ul>
                <h2>{t("about.sinclairRomHeading")}</h2>
                <blockquote>
                    {t("about.sinclairRomText")}
                </blockquote>
                <a href="https://worldofspectrum.net/assets/amstrad-roms.txt" target="_blank">comp.sys.sinclair</a> 1999-08-31
            </Card>
        </Titled>
    )
}
