using System.Net;
using Serilog;
using SteveR.Auth.Model;
using SteveR.Auth.Repositories;
using SteveR.Auth.Tokens;

namespace SteveR.Auth;

public static class UserLogin
{
    public static async Task<HttpStatusCode> PerformLoginAsync(
        string username,
        DateTime expiry,
        UserRepository userRepository,
        SessionRepository sessionRepository,
        CookieRepository cookieRepository,
        IConfiguration configuration,
        HttpRequest request,
        HttpResponse response,
        string? email = null)
    {
        if (string.IsNullOrEmpty(username))
        {
            return HttpStatusCode.BadRequest;
        }

        // Check if user exists by username (username is stable and won't change)
        User? user = await userRepository.GetUser(username);

        // Fallback to email lookup for edge cases
        if (user == null && !string.IsNullOrEmpty(email))
        {
            user = await userRepository.GetUserByEmail(email);
        }

        if (user == null)
        {
            if (!bool.Parse(configuration["SAML:AdmitNewUsers"]))
            {
                return HttpStatusCode.Unauthorized;
            }

            // Automatically create user in database if they do not already exist there.
            Log.Information("New user: {0} ({1})", username, email);
            await userRepository.CreateUser(username, email);

            // Fetch the newly created user
            user = await userRepository.GetUser(username);
            if (user == null)
            {
                return HttpStatusCode.BadRequest;
            }
        }
        else
        {
            Log.Information("Returning user: {0} ({1})", user.Username, email);

            // Update email address for returning users in case it changed in Auth0
            if (!string.IsNullOrEmpty(email) && user.Username != null)
            {
                await userRepository.UpdateUserEmail(user.Username, email);
            }
        }

        // Session data.
        var userId = user.UserId;
        var authToken = GetRandomString(64);
        var created = DateTime.UtcNow;
        var expires = expiry.ToUniversalTime();

        if (userId == null)
        {
            throw new InvalidOperationException();
        }

        // Add session record to Session to table.
        await sessionRepository.CreateSession(userId, authToken, created, expires);

        // Get JWT with session ID embedded.
        var dispenser = new SessionTokenDispenser(configuration);
        var token = await dispenser.GenerateAccessToken(authToken, userId, userRepository);

        // NOTE: Authentication cookie stored with care to avoid CSRF attacks.
        response.Cookies.Append(configuration["SAML:AuthCookieName"], token, new CookieOptions
        {
            SameSite = SameSiteMode.Lax, // This prevents cookie being sent to 3rd-party sites on resource requests.

            // Secure cookie, except in development.
#if DEBUG
            Secure = false,
#else
            Secure = true,
#endif
            HttpOnly = true, // This cookie is not available to JavaScript.
            Expires = expiry, // Expiry defined by SAML server, when specified there - or a default value otherwise.
            IsEssential = true
        });

        response.Redirect(cookieRepository.PopReturnUrl(request, response));
        return HttpStatusCode.Redirect;
    }

    private static string GetRandomString(int length)
    {
        const string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        var stringChars = new char[length];
        var random = new Random();

        for (var i = 0; i < stringChars.Length; i++)
        {
            stringChars[i] = chars[random.Next(chars.Length)];
        }

        return new string(stringChars);
    }
}
