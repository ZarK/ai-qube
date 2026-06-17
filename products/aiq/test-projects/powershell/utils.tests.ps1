BeforeAll {
    . $PSScriptRoot/utils.ps1
}

Describe "Test-IsEmpty" {
    It "returns true for empty string" {
        Test-IsEmpty "" | Should -BeTrue
    }

    It "returns true for whitespace" {
        Test-IsEmpty "   " | Should -BeTrue
    }

    It "returns false for non-empty string" {
        Test-IsEmpty "hello" | Should -BeFalse
    }
}

Describe "ConvertTo-Upper" {
    It "converts lowercase to uppercase" {
        ConvertTo-Upper "hello" | Should -Be "HELLO"
    }

    It "preserves uppercase" {
        ConvertTo-Upper "HELLO" | Should -Be "HELLO"
    }

    It "handles mixed case" {
        ConvertTo-Upper "Hello World" | Should -Be "HELLO WORLD"
    }
}

Describe "ConvertTo-Lower" {
    It "converts uppercase to lowercase" {
        ConvertTo-Lower "HELLO" | Should -Be "hello"
    }

    It "preserves lowercase" {
        ConvertTo-Lower "hello" | Should -Be "hello"
    }
}

Describe "Test-IsEven" {
    It "returns true for even number" {
        Test-IsEven 4 | Should -BeTrue
    }

    It "returns false for odd number" {
        Test-IsEven 3 | Should -BeFalse
    }

    It "returns true for zero" {
        Test-IsEven 0 | Should -BeTrue
    }
}

Describe "Test-IsOdd" {
    It "returns true for odd number" {
        Test-IsOdd 3 | Should -BeTrue
    }

    It "returns false for even number" {
        Test-IsOdd 4 | Should -BeFalse
    }

    It "returns false for zero" {
        Test-IsOdd 0 | Should -BeFalse
    }
}

Describe "Get-ReversedString" {
    It "reverses a string" {
        Get-ReversedString "hello" | Should -Be "olleh"
    }

    It "handles empty string" {
        Get-ReversedString "" | Should -Be ""
    }

    It "handles single character" {
        Get-ReversedString "a" | Should -Be "a"
    }
}

Describe "Get-WordCount" {
    It "counts words in a sentence" {
        Get-WordCount "hello world test" | Should -Be 3
    }

    It "returns 0 for empty string" {
        Get-WordCount "" | Should -Be 0
    }

    It "handles multiple spaces" {
        Get-WordCount "hello   world" | Should -Be 2
    }

    It "counts single word" {
        Get-WordCount "hello" | Should -Be 1
    }
}
