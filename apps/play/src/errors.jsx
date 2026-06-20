import React from "react";
import {error} from "./redux/error/actions";
import {store} from "./redux/store";
import {dashboardUnlock} from "./dashboard_lock";

export function handleError(title, data) {
    dashboardUnlock();
    console.error(title, data);
    store.dispatch(error(title));
}

export function handleException(e) {
    dashboardUnlock();
    console.error(e);
    store.dispatch(error(`[Exception] ${e}`));
}

export function handleRequestException(e) {
    dashboardUnlock();
    console.error(e);
    const {title, description} = getRequestError(e);
    store.dispatch(error(`${title}. ${description}`));
}

function getRequestError(e) {
    if (e && e.response && e.response.status) {

        // See https://en.wikipedia.org/wiki/List_of_HTTP_status_codes
        const statusCode = e.response.status;

        switch (statusCode) {
            case 400: return {
                title: 'Bad Request',
                description: e.response.data
            };

            case 409: return {
                title: 'Conflict',
                description: e.response.data
            };

            case 500: return {
                title: 'Internal Server Error',
                description: 'The server reported an error. It was not ' +
                    'possible to complete the request at this time.'
            };

            default: return {
                title: `HTTP Error: ${statusCode}`,
                description: e.response.data
            }
        }
    }

    return {
        title: 'Server Request Failed',
        description: 'Unexpected exception error when making the request.'
    }
}

export function showToastsForErrorItems(errorItems, toast) {
    if (errorItems && errorItems.length > 0 && toast.current) {
        const toasts = [];

        for (let i = 0; i < errorItems.length; i++) {
            const item = errorItems[i];
            toasts.push(getBuildErrorToast(item));
        }

        toast.current.show(toasts);
    }
}

function getBuildErrorToast(item) {
    if (item.type) {
        return getBuildErrorWasmCommandToast(item);
    } else if (item.line) {
        return getBuildErrorWorkerToast(item);
    }
}

function getBuildErrorWasmCommandToast(item) {
    let isError = false;
    let msg = item.text;

    const errorPrefix = 'ERROR: ';

    if (msg.startsWith(errorPrefix)) {
        isError = true;
        msg = msg.substr(errorPrefix.length);
    }

    if (item.type === 'err') {
        isError = true;
    }

    return {
        severity: isError ? 'error' : 'info',
        sticky: true,
        content: getBuildErrorToastContent(msg, isError)
    };
}

function getBuildErrorWorkerToast(item) {
    let isError = false;
    let msg = item.msg;

    const errorPrefix = 'error: ';

    if (msg.startsWith(errorPrefix)) {
        isError = true;
        msg = msg.substr(errorPrefix.length);
    }

    msg = `Line ${item.line}: ${msg}`;

    return {
        severity: isError ? 'error' : 'info',
        sticky: true,
        content: getBuildErrorToastContent(msg, isError)
    };
}

function getBuildErrorToastContent(msg, isError) {
    return (
        <div className="p-toast-message-text">
            <span className="p-toast-summary">
                Project Run - {isError ? 'Error' : 'Message'}
            </span>
            <div className="p-toast-detail">
                {msg}
            </div>
        </div>
    )
}
