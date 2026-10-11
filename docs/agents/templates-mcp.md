# Templates MCP Server

`pnpm mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio that exposes this repository to coding agents such as Claude Code, Codex and Cursor. It is a local, read-only tool: it answers questions about the catalog, serves template files, builds `create-solana-dapp` commands and reads the latest health report. It never runs installs, never executes the scaffold command and never leaves the template directories.

Source: `scripts/mcp-server.ts` (stdio entry point) and `scripts/mcp/` (catalog, search, files, health, scaffold, server). Tests: `pnpm mcp:test`.

## Tools

Every tool returns JSON as text content. Failures (unknown id, refused path, missing report) come back as tool errors with a message that says what to do next.

| Tool                   | Input                                   | Returns                                                                                              |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `list_templates`       | `group?`, `kind?`, `needsSecrets?`      | Groups plus one entry per template: id, name, description, kind, keywords, package manager, secrets. |
| `search_templates`     | `query`, `limit?`, `group?`, `kind?`    | Ranked hits over id, name, description, keywords, dependency names and README headings.              |
| `get_template`         | `id`                                    | Full metadata: scripts, dependency names, `create-solana-dapp` config, README headings, scaffold.    |
| `list_template_files`  | `id`, `maxDepth?`                       | Files and directories inside the template, with a `truncated` flag when caps apply.                  |
| `get_template_file`    | `id`, `path`                            | One text file (template-relative path), with its size.                                               |
| `get_scaffold_command` | `id`, `packageManager?`, `projectName?` | The `create-solana-dapp` command for the template and its post-create instructions.                  |
| `get_health_summary`   | none                                    | Pass, warn, fail counts and per-template dimension statuses from the latest `pnpm health` report.    |
| `get_template_health`  | `id`                                    | The full health record of one template from that report.                                             |

Template ids are group-relative paths, the same ones used in `templates.json`, for example `kit/nextjs` or `community/x402-template`. `kind` is one of `next`, `vite`, `expo`, `rust`, `node`, `unknown`, classified with the same heuristics as the health check (`Cargo.toml`, `expo`, `next`, `vite` dependencies).

## Resources

| URI                      | Content                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `templates://catalog`    | The whole catalog as JSON (every template with metadata and classification).        |
| `template://{id}/readme` | The README of one template as Markdown, for example `template://kit/nextjs/readme`. |

## Registering the server

The server needs a checkout of this repository and `pnpm install` run at the root. Replace `/path/to/templates` with the checkout location.

Claude Code:

```sh
claude mcp add templates -- pnpm --dir /path/to/templates mcp
```

Codex CLI:

```sh
codex mcp add templates -- pnpm --dir /path/to/templates mcp
```

Cursor and other clients that read a `.mcp.json` or `mcp.json` file:

```json
{
  "mcpServers": {
    "templates": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/templates", "mcp"]
    }
  }
}
```

To serve a different checkout than the one the script lives in, pass `--root`: `pnpm mcp -- --root /other/templates`.

## Safety boundaries

- Only files inside a template directory listed in root `package.json` `repokit.groups` are readable. `..` and absolute paths are refused. Symlinks are refused outright: the canonical path (after `realpath`) must be exactly where the requested path points, so a link cannot alias an env file, install output or anything outside the template. Listings skip symlinks, and the catalog ignores a symlinked README, `.env.example` or `og-image.png`.
- `.env`, `.env.*` (including `.env.example`), `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `.next`, `.expo`, `.turbo` and `coverage` are never listed or served. `.env.example` stays denied on purpose: its placeholders are already surfaced as `credentialKeys` on the template, so an agent knows what to configure without reading the file.
- Binary files and files above 200 KB are refused. Listings stop at a configurable depth (default 3, max 8) and 500 entries.
- Nothing is executed: `get_scaffold_command` returns a string, and the agent or the user decides whether to run it. Project names are validated to letters, numbers, dots, dashes and underscores. The npm form puts the initializer arguments after `--` (`npm create solana-dapp@latest -- -t gh:... my-app`) because npm would otherwise consume `-t` as its own `--tag` flag; pnpm and yarn forward the arguments as is, the same way CI calls them.
- The server does no network access. All answers come from the local checkout.
- Absolute paths of the checkout are not included in tool output.

## Health reports and `pnpm health`

`get_health_summary` and `get_template_health` read the newest `health-reports/*.json` file written by the templates health check (`pnpm health`). That directory is gitignored and reports are produced locally, so on a fresh checkout both tools answer `{"available": false, "note": "..."}`. The note depends on the checkout:

- If `scripts/health-check.ts` exists, it says to run `pnpm health` (or `pnpm health --only kit/nextjs` for one template). Run it, then call the tool again; the newest report is picked by file name, which is the run timestamp.
- If it does not exist, the health check is not in this checkout yet (it lands with solana-foundation/templates PR #420) and the note says so. The tools keep returning `available: false` until that PR is merged and a report has been generated.

The server only reads reports. It never triggers a health run, because that installs and builds templates and can take a long time.

## Maintaining the server

- Add or change a tool in `scripts/mcp/server.ts` and cover it in `scripts/mcp/server.test.ts`, which spawns the real server over stdio.
- Catalog heuristics (kind, secrets) live in `scripts/mcp/catalog.ts`. Keep them aligned with the health check in `scripts/health/` when that changes.
- `scripts/mcp/health-types.ts` is a minimal copy of the health report shape. If `pnpm health` changes its schema, update it there.
- Run `pnpm format`, `pnpm lint` and `pnpm mcp:test` before opening a PR.
