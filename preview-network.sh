#!/bin/bash

responseFile="$1"
request="$2"

requestId="$(echo "$request" | rev | cut -d ' ' -f1 | rev)"

tail -n +0 -f "$responseFile" | while read -r line; do
  response="$(echo "$line" | \
    jq ". | select( .requestId == \"$requestId\" )" \
  )"
  if [[ -z "$response" ]]; then
    continue
  fi
  echo "$response" \
    | jq -r '. | {status: .response.status, url: .response.url, contentType: .response.headers."Content-Type"} | to_entries | map("\(.key): \(.value)") | join("\n")'
done
