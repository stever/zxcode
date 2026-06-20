import React from "react";
import {Card} from "primereact/card";
import {Titled} from "react-titled";
import {sep} from "../constants";

export default function ErrorNotFoundPage() {
    return (
        <Titled title={(s) => `Not Found ${sep} ${s}`}>
            <Card className="m-2">
                <h1>Not Found</h1>
                <p>
                    Requested page location not found.
                </p>
            </Card>
        </Titled>
    )
}
