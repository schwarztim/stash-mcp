#!/bin/bash
set -e
npm install
npm run build
echo "Add to ~/.claude/user-mcps.json or run: npx stash-mcp"
