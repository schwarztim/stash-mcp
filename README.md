# Stash MCP

Professional MCP (Model Context Protocol) server for Bitbucket Server/Data Center (formerly Stash). It provides high-signal tools for project discovery, repository browsing, pull request workflows, and code search.

![CI](https://github.com/schwarztim/stash-mcp/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/schwarztim/stash-mcp)

## Features

- Project and repository discovery
- Pull request lifecycle management (create, review, merge, decline)
- Commenting and inline review notes
- Diff viewing with safe truncation for large files
- Code search (when enabled on the server)
- Read-only mode to prevent write operations

## Requirements

- Node.js 18+
- Bitbucket Server/Data Center (Stash) REST API access

## Install

```bash
npm install
npm run build
```

Or use the helper script:

```bash
./scripts/install.sh
```

## Configuration

Add to `~/.claude/user-mcps.json`:

```json
{
  "mcpServers": {
    "stash": {
      "command": "node",
      "args": ["/absolute/path/to/stash-mcp/dist/index.js"],
      "env": {
        "BITBUCKET_URL": "https://stash.example.com",
        "BITBUCKET_TOKEN": "your-access-token",
        "BITBUCKET_DEFAULT_PROJECT": "PROJ"
      }
    }
  }
}
```

### Environment Variables

- `BITBUCKET_URL` (required): Base URL of your Bitbucket Server instance.
- `BITBUCKET_TOKEN`: Personal access token (recommended).
- `BITBUCKET_USERNAME` / `BITBUCKET_PASSWORD`: Basic auth alternative.
- `BITBUCKET_DEFAULT_PROJECT`: Default project key when `project` is omitted.
- `BITBUCKET_DIFF_MAX_LINES_PER_FILE`: Diff truncation limit per file.
- `BITBUCKET_READ_ONLY`: Set to `true` to disable write operations.

## Usage

### List projects

```
list_projects:
  limit: 25
```

### List repositories

```
list_repositories:
  project: PROJ
```

### Review a pull request

```
get_pull_request:
  project: PROJ
  repository: my-repo
  prId: 123
```

### Search for a file

```
search:
  query: README.md
  type: file
  project: PROJ
```

## Read-Only Mode

Set `BITBUCKET_READ_ONLY=true` to block write operations. Read-only mode allows safe browsing and review without modifying repositories.

## Development

```bash
npm run build
npm test
npm run lint
```

## Security

Please report security issues privately. See `SECURITY.md` for guidance.

## License

MIT. See `LICENSE`.
