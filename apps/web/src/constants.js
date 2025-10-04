// NOTE: Some constants provided by webpack & defined in webpack.config.js files.
const stagingEnv = STAGING_ENV;
const authBase = AUTH_BASE;
const hostname = HOSTNAME;
const httpProtocol = HTTP_PROTO;

const isDev = stagingEnv !== 'prod';
const devLogging = false;

const hasuraBase = `${hostname}/api`;

export default {
    authBase,
    enableBoriel: isDev,
    enableZ88dk: isDev,
    graphQlEndpoint: `${httpProtocol}://${hasuraBase}/v1/graphql`,
    graphQlSubscriptionEndpoint: `${httpProtocol === 'https' ? 'wss' : 'ws'}://${hasuraBase}/v1/graphql`,
    isDev,
    logActions: isDev && devLogging,
    logSubs: isDev && devLogging,
    stagingEnv,
}

export const sep = '|';
