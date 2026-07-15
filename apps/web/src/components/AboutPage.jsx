import React from "react";
import {Link} from "react-router-dom";
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
                        <a href="https://pasmo.speccy.org/" target="_blank">Pasmo</a> by Julián Albo García, alias "NotFound".
                        Licensed under terms of The GPL version 3 - see{' '}
                        <a href="https://github.com/stever/emscripten-pasmo/blob/main/COPYING" target="_blank">COPYING</a>.
                    </li>
                    <li>
                        <a href="https://github.com/stever/emscripten-zmakebas" target="_blank">zmakebas</a> by Russell Marks.
                        This tool is public domain.
                    </li>
                    <li>
                        <a href="https://github.com/stever/emscripten-bas2tap" target="_blank">bas2tap</a> by
                        Martijn van der Heide (ThunderWare Research Center).
                        Licensed under terms of The GPL version 2 - see{' '}
                        <a href="https://github.com/stever/emscripten-bas2tap/blob/main/LICENSE" target="_blank">LICENSE</a>.
                    </li>
                    <li>
                        <a href="https://github.com/z00m128/sjasmplus" target="_blank">sjasmplus</a> by
                        Aprisobal and contributors — used both as a project language and as the
                        assembler backend for Pasta80. Licensed under terms of The BSD 3-Clause
                        License - see{' '}
                        <a href="https://github.com/z00m128/sjasmplus/blob/master/LICENSE.md" target="_blank">LICENSE.md</a>.
                    </li>
                    <li>
                        <a href="https://github.com/pleumann/pasta80" target="_blank">PASTA/80</a> by
                        Jörg Pleumann — the Turbo Pascal 3.0-compatible Pascal compiler.
                        Licensed under terms of The GPL version 3, with a linking exception for
                        its run-time library - see{' '}
                        <a href="https://github.com/pleumann/pasta80/blob/master/LICENSE.txt" target="_blank">LICENSE.txt</a>.
                    </li>
                    <li>
                        <a href="https://github.com/remy/txt2bas" target="_blank">txt2bas</a> by Remy Sharp,
                        the in-browser NextBASIC tokeniser. Licensed under terms of{' '}
                        <a href="https://github.com/remy/txt2bas/blob/main/package.json" target="_blank">The MIT License</a>.
                    </li>
                    <li>
                        <a href="https://github.com/remy/zx-tools" target="_blank">zx-tools</a> by
                        Remy Sharp — this IDE{"'"}s sprite, palette and tile map editors are
                        original code, but their design is based on his Next tooling
                        (see <a href="https://zx.remysharp.com/sprites/" target="_blank">zx.remysharp.com</a>):
                        the .spr/.pal/.map file handling, drawing tools and key bindings all
                        follow it. zx-tools is licensed under terms of The MIT License.
                    </li>
                    <li>
                        <a href="https://github.com/sehugg/8bitworkshop" target="_blank">8bitworkshop</a> by
                        Steven Hugg. Licensed under terms of The GPL version 3 - see{' '}
                        <a href="https://github.com/sehugg/8bitworkshop/blob/master/LICENSE" target="_blank">LICENSE</a>.
                    </li>
                    <li>
                        <a href="http://48k.ca/zmac.html" target="_blank">zmac</a> by Bruce Norskog
                        and many others, maintained by George Phillips (bundled via the
                        8bitworkshop worker). Released under the CC0 Public Domain Dedication.
                    </li>
                    <li>
                        <a href="https://sdcc.sourceforge.net/" target="_blank">SDCC</a> — the Small
                        Device C Compiler, by Sandeep Dutta and contributors (bundled via the
                        8bitworkshop worker). Licensed under terms of The GPL version 2.
                    </li>
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
                    <li>
                        <a href="https://github.com/Stuk/jszip" target="_blank">JSZip</a> by
                        Stuart Knightley — used to open zipped tape and snapshot archives.
                        Dual-licensed under The MIT License or the GPL version 3 - see{' '}
                        <a href="https://github.com/Stuk/jszip/blob/main/LICENSE.markdown" target="_blank">LICENSE</a>.
                    </li>
                    <li>
                        <a href="https://codemirror.net/5/" target="_blank">CodeMirror</a> by
                        Marijn Haverbeke — the code editor component. Licensed under terms of
                        The MIT License - see{' '}
                        <a href="https://github.com/codemirror/codemirror5/blob/master/LICENSE" target="_blank">LICENSE</a>.
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
