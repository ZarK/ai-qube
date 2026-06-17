#!/usr/bin/env bash

set -euo pipefail

is_empty() {
	local str="$1"
	[[ -z "$str" ]]
}

to_upper() {
	local str="$1"
	echo "$str" | tr '[:lower:]' '[:upper:]'
}

to_lower() {
	local str="$1"
	echo "$str" | tr '[:upper:]' '[:lower:]'
}

is_even() {
	local num="$1"
	((num % 2 == 0))
}

is_odd() {
	local num="$1"
	((num % 2 != 0))
}

reverse_string() {
	local str="$1"
	echo "$str" | rev
}

count_words() {
	local str="$1"
	echo "$str" | wc -w | tr -d ' '
}
