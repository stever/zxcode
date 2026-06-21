import React from "react";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {useTranslation, Trans} from "@zxplay/i18n";
import {sep} from "../constants";

export default function LinkingPage() {
    const {t} = useTranslation();
    const domain = `${window.location.protocol}//${window.location.host}/`;
    const k = '-W-P,ASDe,123456789M';
    const m = '48';
    const u = 'https://davidprograma.github.io/ytc/09-ZxSpectrum/snake-1.01.tap';
    const href = `${domain}?k=${k}&m=${m}&u=${u}`;
    return (
        <Titled title={(s) => `${t("nav.linking")} ${sep} ${s}`}>
            <Card className="m-2">
                <h1>{t("nav.linking")}</h1>
                <p>
                    {t("linking.intro")}
                </p>
                <p>{t("linking.example")}</p>
                <p><a href={href}>{href}</a></p>
                <p>{t("linking.decompose")}</p>
                <ul>
                    <li><b>{t("linking.mainPart")}</b><code>https://zxplay.org/</code></li>
                    <li><b>{t("linking.softKeys")}</b><code>?k=-W-P,ASDe,123456789M</code></li>
                    <li><b>{t("linking.machineType")}</b><code>&m=48</code></li>
                    <li>
                        <b>{t("linking.programUrl")}</b>
                        <code>&u=https://davidprograma.github.io/ytc/09-ZxSpectrum/snake-1.01.tap</code>
                    </li>
                    <li><b>{t("linking.filtering")}</b><code>&f=1</code></li>
                </ul>
                <p>
                    <Trans i18nKey="linking.buildOwn" components={{b: <b/>}}/>
                </p>
                <h2>{t("linking.softKeySyntaxHeading")}</h2>
                <p>
                    {t("linking.syntaxSimple")}
                </p>
                <p>{t("linking.threeRows")}</p>
                <ol>
                    <li><code>-W-P</code></li>
                    <li><code>ASDe</code></li>
                    <li><code>123456789M</code></li>
                </ol>
                <p>
                    {t("linking.keyDefinition")}
                </p>
                <p>{t("linking.exceptionsAre")}</p>
                <ul>
                    <li>{t("linking.enterKey")}</li>
                    <li>{t("linking.capsShift")}</li>
                    <li>{t("linking.symbolShift")}</li>
                    <li>{t("linking.space")}</li>
                </ul>
            </Card>
        </Titled>
    )
}
