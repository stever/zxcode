using System.Net;
using Microsoft.AspNetCore.Mvc;
using Serilog;
using SteveR.Auth.Repositories;
using SteveR.Auth.Saml;

namespace SteveR.Auth.Controllers;

[ApiController]
[Route("assertion-consumer")]
public class AssertionConsumerController : ControllerBase
{
    private readonly IConfiguration _configuration;

    public AssertionConsumerController(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    [HttpPost]
    public async Task<HttpStatusCode> ReceiveSamlResponse(
        [FromServices] SessionRepository sessionRepository,
        [FromServices] UserRepository userRepository,
        [FromServices] CookieRepository cookieRepository)
    {
        var formFields = Request.Form.ToDictionary(
            x => x.Key,
            x => x.Value.ToString());

        // This page is only for handling responses from the SAML IdP server.
        if (!formFields.ContainsKey("SAMLResponse"))
        {
            return HttpStatusCode.BadRequest;
        }

        var samlResponse = new SamlResponse(
            _configuration["SAML:ResponseCertificate"],
            int.Parse(_configuration["SAML:DefaultExpirationMinutes"]),
            Request.Form["SAMLResponse"]);

        if (!samlResponse.IsValid(out var err))
        {
            Log.Error("Invalid SAML response: {0}", err);
            return HttpStatusCode.BadRequest;
        }

        // Ensure that we haven't parsed some other type of SAML response.
        var xmlRoot = samlResponse.GetRootElementName();
        if (xmlRoot != "samlp:Response")
        {
            return HttpStatusCode.BadRequest;
        }

        // Extract username from SAML NameID (Auth0 ID)
        var username = samlResponse.GetUserNameId()?.Trim();

        // Extract email from SAML response
        var email = samlResponse.GetEmail()?.Trim();

        // Match the expiry in the SAML response in the ticket below.
        var expiry = samlResponse.GetSessionExpiry();
        Log.Information("Authorisation expiration: {0}", expiry);

        return await UserLogin.PerformLoginAsync(
            username,
            expiry,
            userRepository,
            sessionRepository,
            cookieRepository,
            _configuration,
            Request,
            Response,
            email);
    }
}