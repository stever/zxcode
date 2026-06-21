import React, {useEffect} from "react";
import {useDispatch} from "react-redux";
import {useParams} from "react-router-dom";
import {Card} from "primereact/card";
import {Titled} from "react-titled";
import {useTranslation} from "@zxplay/i18n";
import {sep} from "../constants";

export default function YourProfilePage() {
    const {t} = useTranslation();
    const {id} = useParams();

    const dispatch = useDispatch();

    useEffect(() => {
        // dispatch(loadProfile(id));
        // return () => {}
    }, [id]);

    return (
        <Titled title={(s) => `${t("pages.yourProfile")} ${sep} ${s}`}>
            <Card className="m-2">
                <h1>{t("pages.yourProfile")}</h1>
            </Card>
        </Titled>
    )
}
