using DotNetFixture;

namespace DotNetFixture.Tests;

public class GreeterTests
{
    [Fact]
    public void CreateGreeting_returns_trimmed_greeting()
    {
        var greeting = Greeter.CreateGreeting("  AIQ  ");

        Assert.Equal("Hello, AIQ!", greeting);
    }
}
