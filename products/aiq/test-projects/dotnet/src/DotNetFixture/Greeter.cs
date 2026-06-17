namespace DotNetFixture;

public static class Greeter
{
    public static string CreateGreeting(string name)
    {
        var trimmedName = name.Trim();
        return $"Hello, {trimmedName}!";
    }
}
