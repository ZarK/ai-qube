BeforeAll {
    . $PSScriptRoot/example.ps1
}

Describe "Get-Greeting" {
    It "returns default greeting" {
        $result = Get-Greeting
        $result | Should -Be "Hello, World!"
    }

    It "returns personalized greeting" {
        $result = Get-Greeting -Name "Alice"
        $result | Should -Be "Hello, Alice!"
    }
}

Describe "Invoke-Addition" {
    It "adds positive numbers" {
        $result = Invoke-Addition -a 5 -b 3
        $result | Should -Be 8
    }

    It "adds negative numbers" {
        $result = Invoke-Addition -a -2 -b -3
        $result | Should -Be -5
    }

    It "adds zero" {
        $result = Invoke-Addition -a 0 -b 5
        $result | Should -Be 5
    }
}
