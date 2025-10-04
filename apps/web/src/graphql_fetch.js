import axios from "axios";
import {getAuthToken, isExpired, refreshToken} from "./auth";
import {handleError} from "./errors";
import Constants from "./constants";
import {print} from "graphql";
import {dashboardLock, dashboardUnlock} from "./dashboard_lock";

export async function gqlFetch(userId, query, variables, lock) {
    if (typeof lock === 'undefined') lock = true;

    if (lock) dashboardLock();

    if (!userId) {
        return fetchWithToken(null, query, variables, lock);
    }

    const jwt = getAuthToken();

    if (isExpired(jwt)) {
        return refreshToken().then(jwt => fetchWithToken(jwt, query, variables, lock));
    }

    return fetchWithToken(jwt, query, variables, lock);
}

function fetchWithToken(jwt, query, variables, lock) {
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
    };
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`;

    return axios.post(Constants.graphQlEndpoint, {
        query: query instanceof Object ? print(query) : query,
        variables,
    }, {
        headers
    }).then(response => {
        if (lock) dashboardUnlock();

        console.assert(response && response.data, response);
        if (response.data.errors) {
            handleError('GraphQL Query Errors', response.data.errors);
            return;
        }

        return response.data;
    }).catch(e => {
        if (lock) dashboardUnlock();
        handleError('GraphQL Query Exception', e);
    }).finally(() => lock ? dashboardUnlock() : false);
}

/*
export async function fetchWithRetry(query, variables) {
    const retryLimit = 10;
    for (let attempt = 1; attempt < retryLimit; attempt++) {
        const result = await fetch(query, variables);
        if (result) return result;

        // Delay next attempt.
        console.warn(`query attempt ${attempt} of ${retryLimit} failed`);
        await delay(500);
    }

    throw 'Retry limit exceeded';
}

function delay(ms) {
    return new Promise(resolve => setTimeout(() => resolve(), ms));
}
*/
