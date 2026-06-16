namespace SteveR.Auth;

/// <summary>
/// Generates friendly, speccy-themed handles (slug + display name) for accounts
/// whose username is an opaque provider identifier (e.g. "auth0|...").
/// </summary>
public static class HandleGenerator
{
    private static readonly string[] Words1 =
    {
        "beeper", "raster", "attr", "pixel", "sprite", "scanline", "border", "ink", "paper",
        "bright", "flash", "loader", "tape", "micro", "turbo", "retro", "neon", "vector",
        "scroll", "blitz", "basic", "rom", "beam", "clash"
    };

    private static readonly string[] Words2 =
    {
        "wizard", "runner", "hacker", "clash", "byte", "loop", "coder", "ghost", "droid",
        "knight", "racer", "pilot", "ranger", "goblin", "comet", "falcon", "glitch", "demon",
        "crawler", "smith", "phantom", "jumper", "blaster", "rebel"
    };

    /// <summary>
    /// Generates a candidate handle. Uniqueness must be checked by the caller,
    /// retrying as needed against the slug unique index.
    /// </summary>
    public static (string Slug, string DisplayName) Generate()
    {
        var a = Words1[Random.Shared.Next(Words1.Length)];
        var b = Words2[Random.Shared.Next(Words2.Length)];
        var n = Random.Shared.Next(10, 10000); // 2 to 4 digits
        var slug = $"{a}-{b}-{n}";
        var displayName = $"{Capitalize(a)} {Capitalize(b)}";
        return (slug, displayName);
    }

    private static string Capitalize(string s) => char.ToUpperInvariant(s[0]) + s[1..];
}
