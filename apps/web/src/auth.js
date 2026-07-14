import axios from "axios";
import Constants from "./constants";

let authToken = undefined;

export function getAuthToken() {
    return authToken;
}

export function login() {
    window.location.href = `${Constants.authBase}/login?redirect_url=${window.location.href}`;
}

export function logout() {
    authToken = undefined;
    window.location.href = `${Constants.authBase}/logout?redirect_url=${window.location.href}`;
}

export function isExpired(jwt) {
    if (!jwt) return true;
    const b = jwt.split('.');
    const a = b[1];
    const o = JSON.parse(atob(a));
    const s = new Date().getTime() / 1000;
    const exp = o['exp'];
    return exp < s + 30; // NOTE: 30 seconds or more remaining.
}

export function refreshToken() {
    return axios.get(`${Constants.authBase}/token`, {
        withCredentials: true
    }).then(response => {
        const jwt = response.data.token;
        if (!jwt) throw new Error('invalid jwt value');
        authToken = jwt;
        return jwt;
    }).catch(e => {
        if (e.response && e.response.status === 401) {
            // Session lapsed: bounce through the login flow and back to this
            // page. The returned promise never settles — the page is
            // navigating away, and rejecting would flash an error toast.
            login();
            return new Promise(() => {});
        }
        throw e;
    });
}
