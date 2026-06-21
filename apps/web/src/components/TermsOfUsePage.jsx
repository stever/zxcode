import React, {useEffect} from "react";
import {useDispatch, useSelector} from "react-redux";
import ReactMarkdown from "react-markdown";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {requestTermsOfUse} from "../redux/app/actions";
import {sep} from "../constants";
import {useTranslation} from "@zxplay/i18n";

export default function InfoLegacyTerms() {
    const {t} = useTranslation();
    const dispatch = useDispatch();

    const text = useSelector(state => state?.app.termsOfUse);

    useEffect(() => {
        if (!text) {
            dispatch(requestTermsOfUse());
        }
    }, []);

    return (
        <Titled title={(s) => `${t("nav.termsOfUse")} ${sep} ${s}`}>
            <Card className="m-2">
                <ReactMarkdown>
                    {text}
                </ReactMarkdown>
            </Card>
        </Titled>
    )
}
