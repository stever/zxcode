import React from "react";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {useTranslation, Trans} from "@zxplay/i18n";
import {sep} from "../constants";

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
                        components={{coderLink: <a href="https://code.zxplay.org/" target="_blank" rel="noreferrer"/>}}
                    />
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
