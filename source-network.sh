#!/bin/bash

requestFile="$1"

tail -n +0 -f "$requestFile" | while read -r line; do
  echo "$line" \
    | jq -r '. | [.type, .request.method, .request.url, .requestId] | join(" ")'
done
