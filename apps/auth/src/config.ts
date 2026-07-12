// Configuration with the same environment variable conventions the .NET
// service used (AUTH_ prefix, __ for nesting). The generic login settings
// moved from AUTH_SAML__* to AUTH_Login__* when SAML was replaced by the
// magic-link flow; the old names are still read as fallbacks so an
// unmodified deploy compose keeps working. AUTH_DEV_MODE=true (set by the
// npm dev script) layers on local-development defaults.

const DEV_MODE = process.env.AUTH_DEV_MODE === "true";

function env(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
}

// Renamed settings: prefer the new name, fall back to the legacy SAML name.
function loginEnv(setting: string): string | undefined {
    return env(`AUTH_Login__${setting}`) ?? env(`AUTH_SAML__${setting}`);
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

// Dev auto-login is on by default in dev mode; AUTH_DebugAutoLoginUsername=off
// disables it so the real magic-link form can be exercised locally.
function debugAutoLoginUsername(): string | undefined {
    if (!DEV_MODE) return undefined;
    const username = env("AUTH_DebugAutoLoginUsername") ?? "dev";
    return username === "off" ? undefined : username;
}

const smtpPort = parseInt(env("AUTH_SMTP__Port") ?? "465", 10);

export const config = {
    devMode: DEV_MODE,
    port: parseInt(env("PORT") ?? "8080", 10),

    // In dev the whole login flow is bypassed and this user is logged in.
    debugAutoLoginUsername: debugAutoLoginUsername(),

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

    login: {
        defaultExpirationMinutes: parseInt(
            loginEnv("DefaultExpirationMinutes") ?? "480",
            10,
        ),
        admitNewUsers: (loginEnv("AdmitNewUsers") ?? "true") === "true",
        authCookieName: loginEnv("AuthCookieName") ?? "access_token",
        returnUrlCookieName: loginEnv("ReturnUrlCookieName") ?? "redirect_url",
        magicLinkExpiryMinutes: parseInt(
            env("AUTH_Login__MagicLinkExpiryMinutes") ?? "15",
            10,
        ),
    },

    // Outbound mail for the magic links (Migadu: smtp.migadu.com, port 465
    // implicit TLS or 587 STARTTLS, auth = full mailbox address + password).
    // When not configured the mailer logs the link instead of sending.
    smtp: {
        host: env("AUTH_SMTP__Host"),
        port: smtpPort,
        secure: smtpPort === 465,
        username: env("AUTH_SMTP__Username"),
        password: env("AUTH_SMTP__Password"),
        from: env("AUTH_SMTP__From") ?? "ZX Play <noreply@zxplay.org>",
        get configured(): boolean {
            return Boolean(this.host && this.username && this.password);
        },
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
