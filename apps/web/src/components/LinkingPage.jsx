import React from "react";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {sep} from "../constants";

export default function LinkingPage() {
    const domain = `${window.location.protocol}//${window.location.host}/`;
    const k = '-W-P,ASDe,123456789M';
    const m = '48';
    const u = 'https://davidprograma.github.io/ytc/09-ZxSpectrum/snake-1.01.tap';
    const href = `${domain}?k=${k}&m=${m}&u=${u}`;
    return (
        <Titled title={(s) => `Linking ${sep} ${s}`}>
            <Card className="m-2">
                <h1>Linking To ZX Coder</h1>
                <p>
                    You can link directly to ZX Coder using URL parameters to load
                    a program or game tape image from another URL.
                </p>
                <p>Example:</p>
                <p><a href={href}>{href}</a></p>
                <p>The URL can be decomposed in these parts:</p>
                <ul>
                    <li><b>Main part: </b><code>https://zxcoder.org/</code></li>
                    <li><b>Soft keys: </b><code>?k=-W-P,ASDe,123456789M</code></li>
                    <li><b>Machine type (48, 128, 5 for pentagon): </b><code>&m=48</code></li>
                    <li>
                        <b>Program/game URL to load: </b>
                        <code>&u=https://davidprograma.github.io/ytc/09-ZxSpectrum/snake-1.01.tap</code>
                    </li>
                    <li><b>Optional filtering (default 0 is not filtered, good old pixels): </b><code>&f=1</code></li>
                </ul>
                <p>
                    You can build your own URL setting soft keys, machine type
                    (defaults to 48) and a URL for a Z80, SNA, SZX, TZX or TAP file
                    containing the desired game or program. Please note that the
                    program/game URL to load <b>must</b> be hosted in a website
                    with CORS enabled.
                </p>
                <h2>Soft key syntax</h2>
                <p>
                    The syntax is simple: keys are arranged as rows, and rows are
                    separated by commas.
                </p>
                <p>So, the previous strings has 3 rows:</p>
                <ol>
                    <li><code>-W-P</code></li>
                    <li><code>ASDe</code></li>
                    <li><code>123456789M</code></li>
                </ol>
                <p>
                    A key is defined by its UPPERCASE character, and a hyphen (-)
                    means a blank.
                </p>
                <p>The exceptions are:</p>
                <ul>
                    <li>Enter key: e (lowercase e)</li>
                    <li>Caps shift: c (lowercase c)</li>
                    <li>Symbol shift: s (lowercase s)</li>
                    <li>Space: _ (underscore)</li>
                </ul>
            </Card>
        </Titled>
    )
}
