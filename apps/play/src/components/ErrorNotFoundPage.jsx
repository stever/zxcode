import React from "react";
import {Card} from "primereact/card";
import {Titled} from "react-titled";
import {useTranslation} from "@zxplay/i18n";
import {sep} from "../constants";

export default function ErrorNotFoundPage() {
    const {t} = useTranslation();
    return (
        <Titled title={(s) => `${t("errorPage.notFoundTitle")} ${sep} ${s}`}>
            <Card className="m-2">
                <h1>{t("errorPage.notFoundTitle")}</h1>
                <p>
                    {t("errorPage.notFoundBody")}
                </p>
            </Card>
        </Titled>
    )
}
