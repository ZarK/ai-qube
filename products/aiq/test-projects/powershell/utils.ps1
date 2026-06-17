<#
.SYNOPSIS
Returns whether a string is empty or whitespace.

.PARAMETER Value
The string to inspect.
#>
function Test-IsEmpty {
    param(
        [string]$Value
    )
    return [string]::IsNullOrWhiteSpace($Value)
}

<#
.SYNOPSIS
Converts text to uppercase.

.PARAMETER Text
The input text.
#>
function ConvertTo-Upper {
    param(
        [string]$Text
    )
    return $Text.ToUpper()
}

<#
.SYNOPSIS
Converts text to lowercase.

.PARAMETER Text
The input text.
#>
function ConvertTo-Lower {
    param(
        [string]$Text
    )
    return $Text.ToLower()
}

<#
.SYNOPSIS
Returns whether a number is even.

.PARAMETER Number
The number to inspect.
#>
function Test-IsEven {
    param(
        [int]$Number
    )
    return $Number % 2 -eq 0
}

<#
.SYNOPSIS
Returns whether a number is odd.

.PARAMETER Number
The number to inspect.
#>
function Test-IsOdd {
    param(
        [int]$Number
    )
    return $Number % 2 -ne 0
}

<#
.SYNOPSIS
Reverses the characters in a string.

.PARAMETER Text
The input text.
#>
function Get-ReversedString {
    param(
        [string]$Text
    )
    $charArray = $Text.ToCharArray()
    [array]::Reverse($charArray)
    return -join $charArray
}

<#
.SYNOPSIS
Counts the words in a string.

.PARAMETER Text
The input text.
#>
function Get-WordCount {
    param(
        [string]$Text
    )
    if (Test-IsEmpty $Text) {
        return 0
    }
    $words = $Text.Trim() -split '\s+'
    return $words.Count
}
