<#
.SYNOPSIS
Builds a greeting for a name.

.PARAMETER Name
The name to greet.
#>
function Get-Greeting {
    param(
        [string]$Name = "World"
    )
    return "Hello, $Name!"
}

<#
.SYNOPSIS
Adds two integers.

.PARAMETER a
The first value.

.PARAMETER b
The second value.
#>
function Invoke-Addition {
    param(
        [int]$a,
        [int]$b
    )
    return $a + $b
}

<#
.SYNOPSIS
Formats a date as text.

.PARAMETER Date
The date to format.

.PARAMETER Format
The output format string.
#>
function Get-DateString {
    param(
        [datetime]$Date = (Get-Date),
        [string]$Format = "yyyy-MM-dd"
    )
    return $Date.ToString($Format)
}
