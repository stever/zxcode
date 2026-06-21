import React from "react";
import {useParams} from "react-router-dom";
import {Card} from "primereact/card";
import ProjectList from "./ProjectList";
import RequireSubscriber from "./RequireSubscriber";
import {Titled} from "react-titled";
import {useTranslation} from "@zxplay/i18n";
import {sep} from "../constants";

export default function YourProjectsPage() {
    const {t} = useTranslation();
    const {id} = useParams();

    return (
        <Titled title={(s) => `${t("pages.yourProjects")} ${sep} ${s}`}>
            <Card className="m-2">
                <h1>{t("pages.yourProjects")}</h1>
                <RequireSubscriber>
                    <ProjectList/>
                </RequireSubscriber>
            </Card>
        </Titled>
    )
}
