// Configuration with the exact same environment variable names the .NET
// service used (AUTH_ prefix, __ for nesting), so the deploy compose is
// unchanged. Defaults mirror appsettings.json; AUTH_DEV_MODE=true (set by the
// npm dev script) layers on the appsettings.Development.json values the .NET
// DEBUG build carried.

const DEV_MODE = process.env.AUTH_DEV_MODE === "true";

function env(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
}

function dev<T>(value: T): T | undefined {
    return DEV_MODE ? value : undefined;
}

function parseCorsOrigins(): string[] | null {
    const raw = env("AUTH_CorsOrigin");
    if (raw) return JSON.parse(raw) as string[];
    if (DEV_MODE) return ["http://localhost:8080"];
    return null;
}

export const config = {
    devMode: DEV_MODE,
    port: parseInt(env("PORT") ?? "8080", 10),

    // In dev the whole SAML flow is bypassed and this user is logged in.
    debugAutoLoginUsername: DEV_MODE
        ? (env("AUTH_DebugAutoLoginUsername") ?? "dev")
        : undefined,

    authRedirect: env("AUTH_AuthRedirect") ?? dev("http://localhost:8080/") ?? "",
    corsOrigins: parseCorsOrigins(),

    graphql: {
        endpoint:
            env("AUTH_GraphQL__Endpoint") ??
            dev("http://localhost:8080/api/v1/graphql") ??
            "",
        adminSecret:
            env("AUTH_GraphQL__AdminSecret") ?? dev("hasurapassword") ?? "",
    },

    saml: {
        appId: env("AUTH_SAML__AppId") ?? "zxplay",
        defaultExpirationMinutes: parseInt(
            env("AUTH_SAML__DefaultExpirationMinutes") ?? "480",
            10,
        ),
        admitNewUsers: (env("AUTH_SAML__AdmitNewUsers") ?? "true") === "true",
        authCookieName: env("AUTH_SAML__AuthCookieName") ?? "access_token",
        returnUrlCookieName:
            env("AUTH_SAML__ReturnUrlCookieName") ?? "redirect_url",
        responseCertificate: env("AUTH_SAML__ResponseCertificate"),
        assertionConsumer: env("AUTH_SAML__AssertionConsumer"),
        ssoEndpoint: env("AUTH_SAML__SsoEndpoint"),
        logoutLink: env("AUTH_SAML__LogoutLink"),
    },

    jwt: {
        defaultRole: env("AUTH_JWT__DefaultRole") ?? "zxplay-user",
        addDefaultRole: (env("AUTH_JWT__AddDefaultRole") ?? "true") === "true",
        sessionToken: {
            secret:
                env("AUTH_JWT__SessionToken__Secret") ??
                dev("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX") ??
                "",
            issuer: env("AUTH_JWT__SessionToken__Issuer") ?? "zxplay",
            audience: env("AUTH_JWT__SessionToken__Audience") ?? "caddy",
            expirationSeconds: parseInt(
                env("AUTH_JWT__SessionToken__ExpirationSeconds") ?? "28800",
                10,
            ),
        },
        hasuraToken: {
            secret:
                env("AUTH_JWT__HasuraToken__Secret") ??
                dev("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX") ??
                "",
            issuer: env("AUTH_JWT__HasuraToken__Issuer") ?? "zxplay",
            audience: env("AUTH_JWT__HasuraToken__Audience") ?? "hasura",
            expirationSeconds: parseInt(
                env("AUTH_JWT__HasuraToken__ExpirationSeconds") ?? "900",
                10,
            ),
        },
    },
};
