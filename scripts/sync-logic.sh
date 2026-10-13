#!/bin/sh
# docs/logic.js must stay identical to the server copy
cd "$(dirname "$0")/.." && cp apps-script/Logic.js docs/logic.js && echo "synced docs/logic.js"
