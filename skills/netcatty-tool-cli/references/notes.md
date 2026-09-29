# Vault Notes

Read this when the user explicitly wants markdown in Vault -> Notes. These commands are the Skills + CLI names for the MCP `vault_notes_*` tools. They share the same results and approval policy. The CLI also accepts safe stdin and attachment inputs.

Do not use them to add SSH hosts. Host Details metadata uses `vault host-notes get` and `vault host-notes set`.

| MCP tool | CLI |
| --- | --- |
| `vault_notes_list` | `notes list` |
| `vault_notes_get` | `notes get` |
| `vault_notes_create` | `notes create` |
| `vault_notes_update` | `notes update` |
| `vault_notes_delete` | `notes delete` |
| `vault_notes_import` | `notes import` |

## Commands

- List notes:
  - `<netcatty-cli-prefix> notes list --json`
- Read one note by the exact id from `notes list`. Each call returns at most 6000 characters. Pass `--offset` from `nextOffset` and the same `--expected-updated-at` until `nextOffset` is null before summarizing or replacing the whole note. `--query` returns a matching excerpt only. If the note changed, restart the read:
  - `<netcatty-cli-prefix> notes get --note-id <id> --json`
- Create a note when the title is already known. Supply the body through `--content-stdin`. An explicit `--content ""` creates an empty note; omitting the body is rejected. Optional: `--group`, `--tags`, `--linked-host-ids` (JSON arrays):
  - `<netcatty-cli-prefix> notes create --title "Runbook" --content-stdin --json`
- Update by exact id. Send only the fields that change. An explicit empty `--content` clears the body and an explicit empty `--group` clears the folder; omitting a flag keeps the current value:
  - `<netcatty-cli-prefix> notes update --note-id <id> --content-stdin --json`
- Delete by exact id:
  - `<netcatty-cli-prefix> notes delete --note-id <id> --json`
- Import attached Markdown by its zero-based index in `attachment list --json`, without copying its contents into a shell command:
  - `<netcatty-cli-prefix> notes import --attachment-index 0 --json`
- Import generated markdown through stdin. Use `--content-stdin` plus `--file-name` for one document, or `--documents-stdin` for a JSON array of `{fileName, content, title?}`. Do not combine the two. An empty stdin body imports an empty note. Optional `--title` overrides the first level-one heading or file name. `--group` applies to every imported note:
  - `<netcatty-cli-prefix> notes import --file-name runbook.md --content-stdin --json`

## Supplying generated text

Pipe the literal text into stdin. On POSIX shells, use a quoted here-document delimiter chosen so it does not occur as a line in the text:

```sh
<netcatty-cli-prefix> notes import --file-name runbook.md --content-stdin --json <<'NETCATTY_NOTE_7F42'
# Runbook
Literal markdown goes here.
NETCATTY_NOTE_7F42
```

On PowerShell, a single-quoted here-string is literal. Check that the closing `'@` line does not occur in the text:

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
# Runbook
Literal markdown goes here.
'@ | & <netcatty-cli-prefix> notes import --file-name runbook.md --content-stdin --json
```

Never interpolate note text into a command argument. For attached Markdown, prefer `--attachment-index`.

## Approval

`notes create`, `notes update`, `notes delete`, and `notes import` are writes. Confirm mode asks the user to approve each call. Observer mode rejects them. A denial or tool error is authoritative: stop, and do not retry, split the write, or save a local file instead.

`notes list` and `notes get` are read-only.

## Attached markdown

Use `attachment list --json` to identify the Markdown file, then import it with `notes import --attachment-index <index>`. Read it first with `attachment read` when its contents need inspection. For an attached host export, do not import it as a note.
