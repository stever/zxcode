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
                <h2>{t("about.accountsHeading")}</h2>
                <p>
                    {t("about.accountsIntro")}
                </p>
                <p>
                    <Trans
                        i18nKey="about.accountsCoder"
                        components={{coderLink: <a href="https://code.zxplay.org/" target="_blank" rel="noreferrer"/>}}
                    />
                </p>
                <h2>{t("acknowledgements")}</h2>
                <p>
                    {t("about.acknowledgementsIntro")}
                </p>
                <ul>
                    <li>
                        <a href="https://github.com/conorarmstrong/zx_go" target="_blank">zx_go</a> by
                        Conor Armstrong — the ZX Spectrum 48K/128K and Spectrum Next emulator core,
                        compiled to WebAssembly. Upstream is licensed under terms of The MIT License.
                        The core running here is this site{"'"}s modified version: the modifications
                        are licensed under The GPL version 3, making the built core GPLv3 as a whole
                        (it also embeds the Spectrum Next{"'"}s GPLv3 FPGA loader) - see{' '}
                        <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zx_go/LICENSE" target="_blank">LICENSE</a>.
                    </li>
                    <li>
                        <a href="https://github.com/gasman/jsspeccy3" target="_blank">JSSpeccy3</a>{' '}
                        <a href="https://github.com/dcrespo3d/jsspeccy3-mobile" target="_blank">JSSpeccy3-mobile</a>.
                        The emulator UI and keyboard handling descend from these projects
                        (the emulation core itself is now zx_go). Licensed under terms of
                        The GPL version 3 - see{' '}
                        <a href="https://github.com/gasman/jsspeccy3/blob/main/COPYING" target="_blank">COPYING</a>.
                    </li>
                    <li>
                        <a href="https://gitlab.com/thesmog358/tbblue" target="_blank">NextZXOS</a> — the
                        Spectrum Next machine boots the real NextZXOS system software,
                        copyright Garry Lancaster / SpecNext Ltd (Spectrum ROMs copyright
                        Amstrad plc), distributed free of charge under{' '}
                        <a href="/next/licenses/THE-NEXT-LICENSE.txt" target="_blank">The Next License</a>
                        {' '}(served with the assets, alongside the{' '}
                        <a href="/next/licenses/NOTICES.txt" target="_blank">constituent-part notices</a>).
                    </li>
                    <li>
                        <a href="https://github.com/Stuk/jszip" target="_blank">JSZip</a> by
                        Stuart Knightley — used to open zipped tape and snapshot archives.
                        Dual-licensed under The MIT License or the GPL version 3 - see{' '}
                        <a href="https://github.com/Stuk/jszip/blob/main/LICENSE.markdown" target="_blank">LICENSE</a>.
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
                <a href="https://worldofspectrum.net/app/themes/wosc-classic/static/legacy/amstrad-roms.txt" target="_blank">comp.sys.sinclair</a> 1999-08-31
            </Card>
        </Titled>
    )
}
