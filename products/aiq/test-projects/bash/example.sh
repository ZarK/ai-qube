#!/usr/bin/env bash

set -euo pipefail

greet() {
	local name="${1:-World}"
	echo "Hello, $name!"
}

calculate_sum() {
	local sum=0
	for num in "$@"; do
		((sum += num))
	done
	echo "$sum"
}

main() {
	local name="${1:-World}"
	greet "$name"

	local result
	result=$(calculate_sum 1 2 3 4 5)
	echo "Sum: $result"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
