import {put, take, takeLatest, takeEvery, select} from "redux-saga/effects";
import {eventChannel} from "redux-saga";
import {print} from "graphql";
import {actionTypes as userActions} from "../identity/actions";
import {actionTypes, connectClient, notifySubscribeFunctionReceived} from "./actions";
import {SubscriptionClient, EventError, GraphQLError} from "../../graphql_subscription_client";
import {handleRequestException, handleError, handleException} from "../../errors";
import {login, getAuthToken, isExpired, refreshToken} from "../../auth";
import Constants from "../../constants";

// -----------------------------------------------------------------------------
// Action watchers
// -----------------------------------------------------------------------------

// noinspection JSUnusedGlobalSymbols
export function* watchForSetUserInfoActions() {
    yield takeLatest(userActions.setUserInfo, handleSetUserInfo);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForConnectClientActions() {
    yield takeLatest(actionTypes.connectClient, handleConnectClient);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForSubscribeActions() {
    yield takeEvery(actionTypes.subscribe, handleSubscribe);
}

// noinspection JSUnusedGlobalSymbols
export function* watchForUnsubscribeActionActions() {
    yield takeEvery(actionTypes.unsubscribeAction, handleUnsubscribeAction);
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

function* handleSetUserInfo(action) {
    // Login is optional. Only open an authenticated subscription connection for
    // a known user; anonymous identities (userId null) must not be forced to
    // log in via the connectClient -> refreshToken 401 -> login() path.
    if (action.userInfo && action.userInfo.userId) {
        yield put(connectClient());
    }
}

function* handleConnectClient() {
    try {
        // Connect to websocket for GraphQL subscriptions.

        let jwt = getAuthToken();
        if (isExpired(jwt)) {
            try {
                jwt = yield refreshToken();
            } catch (e) {
                if (e.response && e.response.status === 401) {
                    login();
                    return;
                } else {
                    handleRequestException(e);
                    return;
                }
            }
        }

        const chan = yield eventChannel(emitter => {
            const url = Constants.graphQlSubscriptionEndpoint;

            const options = {
                headers: {
                    Authorization: `Bearer ${jwt}`
                }
            };

            const callback = (error, subscribe) => {
                if (!error && !subscribe) {
                    return; // Normal exit.
                }

                if (error) {
                    if (error instanceof EventError) {
                        if (error.event instanceof CloseEvent) {
                            emitter({msgtype: 'reconnect', data: error.event});
                        } else {
                            emitter({msgtype: 'eventError', data: error.event});
                        }
                    } else if (error instanceof GraphQLError) {
                        emitter({msgtype: 'graphqlError', data: error.details});
                    } else {
                        emitter({msgtype: 'error', data: error});
                    }

                    return;
                }

                console.assert(!!subscribe, 'subscribe');
                emitter({msgtype: 'subscribe', data: subscribe});
            }

            const client = new SubscriptionClient(url, options, callback);
            return client.shutdown;
        });

        try {
            while (true) {
                const msg = yield take(chan);
                switch (msg.msgtype) {
                    case 'subscribe':
                        subscribe = msg.data;
                        yield put(notifySubscribeFunctionReceived());

                        // Replace subscriptions.
                        const subscribedActions = yield select((state) => state.subscriber.subscribedActions);
                        for (const key in subscribedActions) {
                            if (!subscribedActions.hasOwnProperty(key)) continue;
                            const action = subscribedActions[key];
                            yield put(action);
                        }

                        break;
                    case 'reconnect':
                        // Recreate eventChannel and re-connect client.
                        // This needs to be done when we renew JWT.
                        yield put(connectClient());
                        // NOTE: Control doesn't go further here, possibly because
                        // we called an action that is received by this handler?
                        return;
                    case 'eventError':
                        handleError('Subscriber Event Error', msg.data);
                        break;
                    case 'graphqlError':
                        handleError('GraphQL Error', msg.data);
                        break;
                    case 'error':
                        handleError('Error', msg.data);
                        break;
                    default:
                        console.warn('unknown msg type', msg);
                        break;
                }
            }
        } finally {
            chan.close();
        }
    } catch (e) {
        handleException(e);
    }
}

function* handleSubscribe(action) {
    try {
        const chan = yield eventChannel(emitter => {
            const callback = (error, data) => {

                if (error && error instanceof EventError && error.event instanceof CloseEvent) {
                    return; // Ignore this error due to client closing.
                }

                emitter({msgtype: 'callback', error, data});
            };

            const query = action.query instanceof Object ? print(action.query) : action.query;
            const variables = action.variables;
            const operationName = null; // NOTE: Not used.

            return subscribe(query, variables, operationName, callback);
        });

        subscriptionChannels[action.action.type] = chan;

        try {
            while (true) {
                const msg = yield take(chan);
                switch (msg.msgtype) {
                    case 'callback':
                        yield put(action.callback(msg.error, msg.data, action.action ? action.action.id : undefined));
                        break;
                    default:
                        console.warn('unknown msg type', msg);
                        break;
                }
            }
        } finally {
            chan.close();
        }
    } catch (e) {
        handleException(e);
    }
}

function* handleUnsubscribeAction(action) {
    try {
        subscriptionChannels[action.action.type].close();
        delete subscriptionChannels[action.action.type];
        yield; // Generator function should have yield (eslint)
    } catch (e) {
        handleException(e);
    }
}

// -----------------------------------------------------------------------------
// Misc.
// -----------------------------------------------------------------------------

// The subscribe function returned by SubscriptionClient on connect.
let subscribe = undefined;

// Associative array with action type as key and the subscribed channel as value.
// This is used to close the channels when the subscription is unsubscribed.
const subscriptionChannels = {};
