import React, {useEffect} from "react";
import {useDispatch, useSelector} from "react-redux";
import ReactMarkdown from "react-markdown";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {requestPrivacyPolicy} from "../redux/app/actions";
import {sep} from "../constants";
import {useTranslation} from "@zxplay/i18n";

export default function PrivacyPolicyPage() {
    const {t} = useTranslation();
    const dispatch = useDispatch();

    const text = useSelector(state => state?.app.privacyPolicy);

    useEffect(() => {
        if (!text) {
            dispatch(requestPrivacyPolicy());
        }
    }, []);

    return (
        <Titled title={(s) => `${t("nav.privacyPolicy")} ${sep} ${s}`}>
            <Card className="m-2">
                <ReactMarkdown>
                    {text}
                </ReactMarkdown>
            </Card>
        </Titled>
    )
}
