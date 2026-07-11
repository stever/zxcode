# SAML Authentication Service

## Configuration

### Deployment environment variables

* `AUTH_AuthRedirect`
* `AUTH_CorsOrigin`
* `AUTH_SAML__AppId`
* `AUTH_SAML__ResponseCertificate`
* `AUTH_SAML__AssertionConsumer`
* `AUTH_SAML__SsoEndpoint`
* `AUTH_SAML__LogoutLink`
* `AUTH_GraphQL__Endpoint`
* `AUTH_GraphQL__AdminSecret`
* `AUTH_JWT__DefaultRole`
* `AUTH_JWT__AddDefaultRole`
* `AUTH_JWT__SessionToken__Secret`
* `AUTH_JWT__SessionToken__Issuer`
* `AUTH_JWT__SessionToken__Audience`
* `AUTH_JWT__SessionToken__ExpirationSeconds`
* `AUTH_JWT__HasuraToken__Secret`
* `AUTH_JWT__HasuraToken__Issuer`
* `AUTH_JWT__HasuraToken__Audience`
* `AUTH_JWT__HasuraToken__ExpirationSeconds`

### IDE Development Settings

NOTE: The following file will not be committed to the repository (see `.gitignore`).

#### App settings for development

```bash
vi dotnet/Auth/appsettings.Development.json
```

```json
{
  "AllowedHosts": "*",
  "AuthRedirect": "http://localhost:3000/",
  "CorsOrigin": "[\"http://127.0.0.1:3000\", \"http://localhost:3000\"]",
  "SAML": {
    "AppId": "auth",
    "ResponseCertificate": "<cert>",
    "AssertionConsumer": "http://localhost:5003/assertion-consumer",
    "SsoEndpoint": "",
    "LogoutLink": "",
    "AuthCookieName": "access_token",
    "ReturnUrlCookieName": "redirect_url",
    "AdmitNewUsers": true,
    "DefaultExpirationMinutes": 480
  },
  "GraphQL": {
    "Endpoint": "https://domain/api/v1/graphql",
    "AdminSecret": "<secret>"
  },
  "JWT": {
    "DefaultRole": "auth-user",
    "AddDefaultRole": true,
    "SessionToken": {
      "Secret": "<secret>",
      "Issuer": "auth",
      "Audience": "caddy",
      "ExpirationSeconds": "28800"
    },
    "HasuraToken": {
      "Secret": "<secret>",
      "Issuer": "auth",
      "Audience": "hasura",
      "ExpirationSeconds": "900"
    }
  }
}
```
