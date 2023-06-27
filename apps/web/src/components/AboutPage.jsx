import React from "react";
import {Link} from "react-router-dom";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import Constants, {sep} from "../constants";

export default function AboutPage() {
    return (
        <Titled title={(s) => `About ${sep} ${s}`}>
            <Card className="m-2">
                <h1>About This Site</h1>
                <p>
                    A ZX Spectrum emulator & programming environment for the browser.
                    Source available <a href="https://github.com/zxplay/zxcoder" target="_blank">here</a>.
                </p>
                <p>
                    An alternative website, related to this one,
                    is available at <a href="https://zxplay.org/" target="_blank">zxplay.org</a>.
                    ZX Play is a mobile-friendly ZX Spectrum emulator, for games.
                </p>
                <p>
                    Please read <Link to="/privacy-policy">privacy policy</Link>
                    {' '}and <Link to="/terms-of-use">terms of use</Link>, for this website.
                </p>
                <h2>Create Projects</h2>
                <p>
                    Registered users can save projects.
                </p>
                <p>
                    Use the Sign-In button above and look for the "Sign Up" link on
                    the proceeding page to create an account.
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
