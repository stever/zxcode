using Newtonsoft.Json;

namespace SteveR.Auth.Model;

public class User
{
    [JsonProperty("user_id")]
    public string? UserId { get; set; }

    [JsonProperty("username")]
    public string? Username { get; set; }

    [JsonProperty("user_roles")]
    public UserRoles[]? UserRoles { get; set; }
}
