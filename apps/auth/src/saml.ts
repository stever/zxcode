// SAML SP integration via @node-saml/node-saml, replacing the hand-vendored
// .NET implementation with equivalent semantics:
// - AuthnRequest: HTTP-Redirect binding, DEFLATE, unsigned (no privateKey),
//   NameID format unspecified.
// - Response validation: signature verified against the configured IdP
//   certificate, accepting a signed Response OR a signed Assertion (the .NET
//   validator anchored on either); no audience or InResponseTo validation
//   (the .NET validator had neither).

import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import { config } from "./config.js";

export interface SamlLoginResult {
    username: string;
    email: string | null;
    sessionExpiry: Date;
}

// The configured certificate may carry literal "\n" sequences and PEM
// header/footer lines; node-saml wants the base64 body (or full PEM).
function normalizeCertificate(raw: string): string {
    return raw
        .replace(/\\n/g, "\n")
        .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
        .replace(/\s+/g, "");
}

export function samlEnabled(): boolean {
    return Boolean(
        config.saml.ssoEndpoint &&
        config.saml.assertionConsumer &&
        config.saml.responseCertificate,
    );
}

let instance: SAML | null = null;

function saml(): SAML {
    if (!samlEnabled()) throw new Error("SAML is not configured");
    if (!instance) {
        instance = new SAML({
            issuer: config.saml.appId,
            entryPoint: config.saml.ssoEndpoint as string,
            callbackUrl: config.saml.assertionConsumer as string,
            idpCert: normalizeCertificate(config.saml.responseCertificate as string),
            identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
            wantAssertionsSigned: false,
            wantAuthnResponseSigned: false,
            audience: false,
            validateInResponseTo: ValidateInResponseTo.never,
            acceptedClockSkewMs: 5000,
        });
    }
    return instance;
}

export async function loginUrl(): Promise<string> {
    return saml().getAuthorizeUrlAsync("", undefined, {});
}

function sessionExpiryFrom(assertionXml: string): Date {
    const fallback = new Date(
        Date.now() + config.saml.defaultExpirationMinutes * 60_000,
    );
    try {
        const document = new DOMParser().parseFromString(assertionXml, "text/xml");
        const statements = document.getElementsByTagNameNS(
            "urn:oasis:names:tc:SAML:2.0:assertion",
            "AuthnStatement",
        );
        const value = statements.item(0)?.getAttribute("SessionNotOnOrAfter");
        if (!value) return fallback;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? fallback : parsed;
    } catch {
        return fallback;
    }
}

export async function validateSamlResponse(
    samlResponse: string,
): Promise<SamlLoginResult> {
    const { profile, loggedOut } = await saml().validatePostResponseAsync({
        SAMLResponse: samlResponse,
    });
    if (loggedOut || !profile?.nameID) {
        throw new Error("SAML response carried no subject");
    }

    // Email: the `email` attribute, the WS-Fed claim URI, or an
    // emailAddress-format NameID — the same precedence the .NET code used.
    const attributes = profile as unknown as Record<string, unknown>;
    const email =
        (typeof attributes.email === "string" ? attributes.email : null) ??
        (typeof attributes[
            "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
        ] === "string"
            ? (attributes[
                "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
            ] as string)
            : null) ??
        (profile.nameIDFormat?.includes("emailAddress") ? profile.nameID : null);

    const assertionXml = profile.getAssertionXml?.() ?? "";
    return {
        username: profile.nameID.trim(),
        email: email?.trim() || null,
        sessionExpiry: sessionExpiryFrom(assertionXml),
    };
}
