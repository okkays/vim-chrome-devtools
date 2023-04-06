#!/bin/bash

responseFile="$1"
previewRequestedFile="$2"
previewFile="$3"
request="$4"

requestId="$(echo "$request" | rev | cut -d ' ' -f1 | rev)"

tail -n +0 -f "$responseFile" | while read -r line; do
  response="$(echo "$line" | \
    jq ". | select( .requestId == \"$requestId\" )" \
  )"
  if [[ -z "$response" ]]; then
    continue
  fi

  echo "$response" \
    | jq -r '. | {Status: .response.status, Url: .response.url, "Content Type": .response.headers."Content-Type"} | to_entries | map("\(.key): \(.value)") | join("\n")'
  echo "Body (press enter to view):"
  echo ""

  rm -f "$previewFile" && touch "$previewFile"
  echo "$requestId" > "$previewRequestedFile"
  break
done

tail -n +0 -f "$previewFile"
