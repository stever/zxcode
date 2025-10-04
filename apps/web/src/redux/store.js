import {createStore, combineReducers, applyMiddleware} from "redux";
import createSagaMiddleware from "redux-saga";
import {all} from "redux-saga/effects";
import {createRouterReducer, createRouterMiddleware} from "@lagunovsky/redux-react-router";
import {createBrowserHistory} from "history";
import Constants from "../constants";

// Reducers
import appReducer from "./app/reducers";
import demoReducer from "./demo/reducers";
import eightbitReducer from "./eightbit/reducers";
import errorReducer from "./error/reducers";
import identityReducer from "./identity/reducers";
import projectReducer from "./project/reducers";
import projectListReducer from "./projectList/reducers";
import socialReducer from "./social/reducers";
import subscriberReducer from "./subscriber/reducers";
import windowReducer from "./window/reducers";

// Sagas
import * as appSagas from "./app/sagas";
import * as demoSagas from "./demo/sagas";
import * as eightbitSagas from "./eightbit/sagas";
import * as identitySagas from "./identity/sagas";
import * as jsspeccySagas from "./jsspeccy/sagas";
import * as projectSagas from "./project/sagas";
import * as projectListSagas from "./projectList/sagas";
import * as socialSagas from "./social/sagas";
import * as subscriberSagas from "./subscriber/sagas";
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
    demo: demoReducer,
    eightbit: eightbitReducer,
    error: errorReducer,
    identity: identityReducer,
    project: projectReducer,
    projectList: projectListReducer,
    social: socialReducer,
    subscriber: subscriberReducer,
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
collectSagas(demoSagas);
collectSagas(eightbitSagas);
collectSagas(identitySagas);
collectSagas(jsspeccySagas);
collectSagas(projectSagas);
collectSagas(projectListSagas);
collectSagas(socialSagas);
collectSagas(subscriberSagas);
collectSagas(windowSagas);

function* rootSaga() {
    yield all(sagas);
}

sagaMiddleware.run(rootSaga);
