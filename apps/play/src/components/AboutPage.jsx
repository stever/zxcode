import React from "react";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {sep} from "../constants";

export default function AboutPage() {
    return (
        <Titled title={(s) => `About ${sep} ${s}`}>
            <Card className="m-2">
                <h1>About This Site</h1>
                <p>
                    A mobile-friendly ZX Spectrum emulator for the browser.
                    Source available <a href="https://github.com/zxplay/zxplay" target="_blank">here</a>.
                </p>
                <p>
                    An alternative website, related to this one,
                    is available at <a href="https://zxcoder.org/" target="_blank">zxcoder.org</a>.
                    ZX Coder supports running programs entered via web pages.
                </p>
                <h2>Acknowledgements</h2>
                <p>
                    This software uses code from the following open source projects:
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
                <h2>Sinclair ROM Copyright Permission</h2>
                <blockquote>
                    Amstrad have kindly given their permission for the
                    redistribution of their copyrighted material but retain that copyright.
                </blockquote>
                <a href="https://worldofspectrum.net/assets/amstrad-roms.txt" target="_blank">comp.sys.sinclair</a> 1999-08-31
            </Card>
        </Titled>
    )
}
