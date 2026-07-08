import React from "react";
import {error} from "./redux/error/actions";
import {store} from "./redux/store";
import {dashboardUnlock} from "./dashboard_lock";
import {i18n} from "@zxplay/i18n";

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
                title: i18n.t('errors.badRequest'),
                description: e.response.data
            };

            case 409: return {
                title: i18n.t('errors.conflict'),
                description: e.response.data
            };

            case 500: return {
                title: i18n.t('errors.serverError'),
                description: i18n.t('errors.serverErrorDetail')
            };

            default: return {
                title: i18n.t('errors.httpError', {statusCode}),
                description: e.response.data
            }
        }
    }

    return {
        title: i18n.t('errors.requestFailed'),
        description: i18n.t('errors.requestFailedDetail')
    }
}

export function showToastsForErrorItems(errorItems, toast) {
    console.log('[build-errors] showToastsForErrorItems', {
        count: errorItems?.length,
        hasToast: Boolean(toast?.current),
        items: errorItems
    });
    if (errorItems && errorItems.length > 0 && toast.current) {
        const toasts = [];

        for (let i = 0; i < errorItems.length; i++) {
            const item = errorItems[i];
            const t = getBuildErrorToast(item);
            if (t) toasts.push(t);
        }

        toast.current.show(toasts);
    }
}

function getBuildErrorToast(item) {
    if (item?.type) {
        return getBuildErrorWasmCommandToast(item);
    }
    // Everything else is a worker-style item ({line, msg}). line 0 marks a
    // whole-program failure (e.g. a linker error) and must still surface.
    return getBuildErrorWorkerToast(item);
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
    let msg = item?.msg ?? String(item);

    const errorPrefix = 'error: ';
    if (msg.startsWith(errorPrefix)) {
        msg = msg.substr(errorPrefix.length);
    }

    // These items come from the build's errors[] (zmac/sdcc diagnostics don't
    // carry an 'error: ' prefix), so default to error severity; only items
    // announcing themselves as warnings get the softer treatment.
    const isError = !/^warning\b/i.test(msg);

    if (item?.line) {
        msg = i18n.t('errors.lineMsg', {line: item.line, msg});
    }

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
                {isError ? i18n.t('errors.projectRunError') : i18n.t('errors.projectRunMessage')}
            </span>
            <div className="p-toast-detail" style={{whiteSpace: 'pre-wrap'}}>
                {msg}
            </div>
        </div>
    )
}
