import React from "react";
import {Button} from "primereact/button";
import {error} from "./redux/error/actions";
import {setBuildOutput, setBuildOutputVisible} from "./redux/project/actions";
import {store} from "./redux/store";
import {dashboardUnlock} from "./dashboard_lock";
import {i18n} from "@zxplay/i18n";
import {processErrorItems, buildToastPlan} from "./lib/buildDiagnostics";

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

// Surface a failed build: errors as individual toasts (deduplicated and
// capped), warnings and stdout chatter folded into one summary toast whose
// button opens the build-output dialog with the complete classified output
// (#217 — a wall of warnings must not bury the errors). The full output is
// published to state.project.buildOutput here, whether or not a toast host is
// mounted, so the dialog always has the whole story.
export function showToastsForErrorItems(errorItems, toast) {
    console.log('[build-errors] showToastsForErrorItems', {
        count: errorItems?.length,
        hasToast: Boolean(toast?.current),
        items: errorItems
    });
    if (!errorItems || errorItems.length === 0) return;

    const units = processErrorItems(errorItems);
    // Standalone items (e.g. a failed renumber) are toast-only: they must
    // not replace the last build's output, which the dialog preserves for
    // as long as that failure is the latest compile result (#217).
    if (!errorItems.every((item) => item?.standalone)) {
        store.dispatch(setBuildOutput(units));
    }

    if (!toast?.current) return;

    const plan = buildToastPlan(units);
    const toasts = [];

    if (plan.legacy) {
        // Nothing in the output is recognisably an error — show everything,
        // exactly as before, rather than gamble on the classifier.
        for (let i = 0; i < errorItems.length; i++) {
            const item = errorItems[i];
            const t = getBuildErrorToast(item);
            if (t) toasts.push(t);
        }
    } else {
        for (const unit of plan.errorToasts) {
            toasts.push(getErrorUnitToast(unit));
        }
        if (plan.summary) {
            toasts.push(getBuildSummaryToast(plan.summary));
        }
    }

    toast.current.show(toasts);
}

function getErrorUnitToast(unit) {
    let msg = unit.text;

    // Cosmetic: the toast header already announces an error.
    for (const prefix of ['ERROR: ', 'error: ']) {
        if (msg.startsWith(prefix)) {
            msg = msg.substr(prefix.length);
            break;
        }
    }

    if (unit.line) {
        msg = i18n.t('errors.lineMsg', {line: unit.line, msg});
    }
    if (unit.count > 1) {
        msg = `${msg} (×${unit.count})`;
    }

    return {
        severity: 'error',
        sticky: true,
        content: getBuildErrorToastContent(msg, true)
    };
}

function getBuildSummaryToast(summary) {
    return {
        severity: 'warn',
        sticky: true,
        content: (
            <div className="p-toast-message-text">
                <span className="p-toast-summary">
                    {i18n.t('errors.buildOutput')}
                </span>
                <div className="p-toast-detail">
                    {i18n.t('errors.buildErrors', {n: summary.errors})}
                    {' · '}
                    {i18n.t('errors.buildWarnings', {n: summary.warnings})}
                </div>
                <Button
                    label={i18n.t('errors.showBuildOutput')}
                    className="p-button-sm mt-2"
                    onClick={() => store.dispatch(setBuildOutputVisible(true))}
                />
            </div>
        )
    };
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
