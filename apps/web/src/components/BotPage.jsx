import React from "react";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {useTranslation, Trans} from "@zxplay/i18n";
import {sep} from "../constants";

// Documentation for the Fediverse bot (apps/mastodon-bot). The tag lists and
// examples are code, not prose, so they stay hardcoded; keep them in sync with
// LANG_TAGS / MACHINE_TAGS in apps/mastodon-bot/src/directives.ts.

// An example toot, set off from the surrounding prose in a bordered panel
// styled loosely like a fediverse post: mentions, hashtags and links get the
// theme's primary colour, the way a real client renders them.
const TOOT_TOKEN = /(@[\w.-]+(?:@[\w.-]+)?|https?:\/\/\S+|#\w+)/g;

function ExampleToot({children}) {
    const parts = String(children).split(TOOT_TOKEN);
    return (
        <pre
            className="p-3 my-3 surface-ground border-1 surface-border border-round-xl overflow-x-auto"
            style={{lineHeight: "1.6"}}
        >
            {parts.map((part, i) => {
                if (/^[@#]/.test(part)) {
                    return <span key={i} className="text-primary font-medium">{part}</span>;
                }
                if (/^https?:\/\//.test(part)) {
                    return <span key={i} className="text-primary underline">{part}</span>;
                }
                return part;
            })}
        </pre>
    );
}

export default function BotPage() {
    const {t} = useTranslation();
    return (
        <Titled title={(s) => `${t("nav.mastodonBot")} ${sep} ${s}`}>
            <Card className="m-2">
                <h1>{t("nav.mastodonBot")}</h1>
                <p>
                    <Trans
                        i18nKey="bot.intro"
                        components={{botLink: <a href="https://social.zxplay.org/@bot" target="_blank" rel="noreferrer"/>}}
                    />
                </p>
                <h2>{t("bot.howToHeading")}</h2>
                <p>
                    {t("bot.howToAddress")}
                </p>
                <ExampleToot>
                    {'@bot@zxplay.org\n' +
                     '10 PRINT "HELLO FROM THE FEDIVERSE"\n' +
                     '20 GO TO 10'}
                </ExampleToot>
                <p>
                    {t("bot.howToReply")}
                </p>
                <h2>{t("bot.machinesHeading")}</h2>
                <p>
                    {t("bot.machinesText")}
                </p>
                <ul>
                    <li><code>#48</code> — ZX Spectrum 48K</li>
                    <li><code>#128</code> — ZX Spectrum 128K</li>
                    <li><code>#next</code> — ZX Spectrum Next</li>
                </ul>
                <h2>{t("bot.languagesHeading")}</h2>
                <p>
                    {t("bot.languagesText")}
                </p>
                <ul>
                    <li><code>#bas2tap</code> — Sinclair BASIC (bas2tap)</li>
                    <li><code>#zxbasic</code> — Boriel ZX BASIC</li>
                    <li><code>#asm</code> — Z80 assembly (Pasmo)</li>
                    <li><code>#sjasmplus</code> — Z80 assembly (sjasmplus)</li>
                    <li><code>#zmac</code> — Z80 assembly (zmac)</li>
                    <li><code>#c</code> — C (z88dk)</li>
                    <li><code>#sdcc</code> — C (SDCC)</li>
                    <li><code>#pascal</code> — Pascal (PASTA/80)</li>
                </ul>
                <ExampleToot>
                    {'@bot@zxplay.org #pascal #next\n' +
                     'program Hi;\n' +
                     'begin\n' +
                     "  WriteLn('Hello!')\n" +
                     'end.'}
                </ExampleToot>
                <p>
                    {t("bot.hashtagNote")}
                </p>
                <h2>{t("bot.projectsHeading")}</h2>
                <p>
                    {t("bot.projectsText")}
                </p>
                <ExampleToot>
                    {'@bot@zxplay.org https://code.zxplay.org/u/steve/my-demo #next'}
                </ExampleToot>
                <h2>{t("bot.limitsHeading")}</h2>
                <ul>
                    <li>{t("bot.limitVisibility")}</li>
                    <li>{t("bot.limitRate")}</li>
                    <li>{t("bot.limitCapture")}</li>
                    <li>{t("bot.limitErrors")}</li>
                </ul>
            </Card>
        </Titled>
    )
}
