# Local Modifications

This is a personal fork of [stash-mcp](https://github.com/schwarztim/stash-mcp) with custom modifications.

See git history for details (`git diff upstream/main`).

## Changes

- Add `get_branch_diff` and `get_commit_diff` tools to inspect diffs between branches/refs and individual commits, not just pull requests
- Add chunked output for PR diffs (`fileOffset`/`fileLimit` pagination) to avoid overwhelming LLM context with large diffs
- Condense activity API responses into compact, LLM-friendly output: users as `name (displayName)`, epoch dates as ISO, inline comment anchors with diff context, rescoped commits with short hashes