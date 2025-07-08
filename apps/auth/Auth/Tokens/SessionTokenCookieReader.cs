using System.IdentityModel.Tokens.Jwt;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace SteveR.Auth.Tokens;

internal class SessionTokenCookieReader
{
    private readonly JwtSecurityToken? _token;
        
    public SessionTokenCookieReader(IConfiguration configuration, string cookie)
    {
        var key = Encoding.ASCII.GetBytes(configuration["JWT:SessionToken:Secret"]);
        var handler = new JwtSecurityTokenHandler();
            
        var validations = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(key),
            ValidateIssuer = false,
            ValidateAudience = false
        };
        
        // Ensure that the token is validated!
        handler.ValidateToken(cookie, validations, out var jsonToken);

        _token = jsonToken as JwtSecurityToken;
    }

    public string? GetAuthToken()
    {
        if (_token == null) return null;
        
        if (!_token.Payload.TryGetValue("props", out var propsObj))
            return null;
            
        if (propsObj is System.Text.Json.JsonElement jsonElement)
        {
            if (jsonElement.ValueKind == System.Text.Json.JsonValueKind.Null)
                return null;
                
            if (jsonElement.TryGetProperty("auth", out var authProperty))
            {
                return authProperty.GetString();
            }
        }
        
        return null;
    }
}