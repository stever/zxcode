import React from "react";
import PropTypes from "prop-types";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {Button} from "primereact/button";
import {useTranslation} from "@zxplay/i18n";
import {sep} from "../constants";

ErrorPage.propTypes = {
    msg: PropTypes.string.isRequired
}

export default function ErrorPage({msg}) {
    const {t} = useTranslation();

    function handleReload() {
        window.location.reload();
    }

    function handleGoHome() {
        window.location.href = '/';
    }

    function handleGoBack() {
        history.back();
    }

    return (
        <Titled title={(s) => `${t("errorPage.errorTitle")} ${sep} ${s}`}>
            <Card className="m-2" style={{textAlign: 'center'}}>
                <div className="m-4">
                    <p>{t("errorPage.title")}</p>
                    <p>{t("errorPage.messageLabel")}</p>
                    <div className="font-italic">{msg}</div>
                </div>
                <div>
                    <p>{t("errorPage.buttonsPrompt")}</p>
                    <Button
                        type="button"
                        className="p-button-outlined mr-3"
                        label={t("errorPage.reload")}
                        title={t("errorPage.reloadTitle")}
                        onClick={handleReload}
                    />
                    <Button
                        type="button"
                        className="p-button-outlined mr-3"
                        label={t("errorPage.restart")}
                        title={t("errorPage.restartTitle")}
                        onClick={handleGoHome}
                    />
                    <Button
                        type="button"
                        className="p-button-outlined"
                        label={t("errorPage.goBack")}
                        title={t("errorPage.goBackTitle")}
                        onClick={handleGoBack}
                    />
                </div>
            </Card>
        </Titled>
    )
}
