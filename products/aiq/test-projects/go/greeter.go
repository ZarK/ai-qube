package fixture

import "strings"

func Greet(name string) string {
	trimmedName := strings.TrimSpace(name)
	return "Hello, " + trimmedName + "!"
}

func Sum(values []int) int {
	total := 0
	for _, value := range values {
		total += value
	}

	return total
}
