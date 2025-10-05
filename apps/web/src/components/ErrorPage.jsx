import React from "react";
import PropTypes from "prop-types";
import {Titled} from "react-titled";
import {Card} from "primereact/card";
import {Button} from "primereact/button";
import {sep} from "../constants";

ErrorPage.propTypes = {
    msg: PropTypes.string.isRequired
}

export default function ErrorPage({msg}) {

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
        <Titled title={(s) => `Error ${sep} ${s}`}>
            <Card className="m-2 text-center">
                <div className="m-4">
                    <p>Sorry, an unexpected error occurred.</p>
                    <p>Error message is:</p>
                    <div className="font-italic">{msg}</div>
                </div>
                <div>
                    <p>Press one of the following buttons:</p>
                    <Button
                        type="button"
                        className="p-button-outlined mr-3"
                        label="Reload"
                        title="Reload this page"
                        onClick={handleReload}
                    />
                    <Button
                        type="button"
                        className="p-button-outlined mr-3"
                        label="Restart"
                        title="Return to home page"
                        onClick={handleGoHome}
                    />
                    <Button
                        type="button"
                        className="p-button-outlined"
                        label="Go Back"
                        title="Go back to previous page"
                        onClick={handleGoBack}
                    />
                </div>
            </Card>
        </Titled>
    )
}
