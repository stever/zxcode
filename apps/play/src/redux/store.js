import {createStore, combineReducers, applyMiddleware} from "redux";
import createSagaMiddleware from "redux-saga";
import {all} from "redux-saga/effects";
import {createRouterReducer, createRouterMiddleware} from "@lagunovsky/redux-react-router";
import {createBrowserHistory} from "history";
import Constants from "../constants";

// Reducers
import appReducer from "./app/reducers";
import errorReducer from "./error/reducers";
import windowReducer from "./window/reducers";

// Sagas
import * as appSagas from "./app/sagas";
import * as jsspeccySagas from "./jsspeccy/sagas";
import * as windowSagas from "./window/sagas";

const loggingMiddleware = (store) => {
    return (next) => {
        return (action) => {

            // noinspection JSUnresolvedVariable
            if (Constants.logActions) {
                const collapsed = false;
                const msg = `Action: ${action.type}`;
                if (collapsed) console.groupCollapsed(msg); else console.group(msg);
                console.log('Action:', action);
                console.log('Previous state:', store.getState());
            }

            const result = next(action);

            // noinspection JSUnresolvedVariable
            if (Constants.logActions) {
                console.log('New state:', store.getState());
                console.groupEnd();
            }

            return result;
        }
    }
};

export const history = createBrowserHistory();
const sagaMiddleware = createSagaMiddleware();

const rootReducer = combineReducers({
    router: createRouterReducer(history),
    app: appReducer,
    error: errorReducer,
    window: windowReducer,
});

export const store = createStore(
    rootReducer,
    applyMiddleware(
        createRouterMiddleware(history),
        loggingMiddleware,
        sagaMiddleware));

const sagas = [];

function collectSagas(file) {
    for (const name in file) {
        if (file.hasOwnProperty(name)) {
            sagas.push(file[name]());
        }
    }
}

collectSagas(appSagas);
collectSagas(jsspeccySagas);
collectSagas(windowSagas);

function* rootSaga() {
    yield all(sagas);
}

sagaMiddleware.run(rootSaga);
