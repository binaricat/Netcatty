# Vault Notes

Read this when the user explicitly wants markdown in Vault -> Notes. These commands are the Skills + CLI names for the MCP `vault_notes_*` tools. They share the same arguments, results, and approval policy.

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
- Create a note when the title is already known. `--title` and `--content` are required. Optional: `--group`, `--tags`, `--linked-host-ids` (JSON arrays):
  - `<netcatty-cli-prefix> notes create --title "<title>" --content "<markdown>" --json`
- Update by exact id. Send only the fields that change:
  - `<netcatty-cli-prefix> notes update --note-id <id> --content "<markdown>" --json`
- Delete by exact id:
  - `<netcatty-cli-prefix> notes delete --note-id <id> --json`
- Import generated or attached markdown. Use `--content` plus `--file-name` for one document, or `--documents` for a JSON array of `{fileName, content, title?}`. Do not send both. Optional `--title` overrides the first heading or file name. `--group` applies to every imported note:
  - `<netcatty-cli-prefix> notes import --file-name runbook.md --content "<markdown>" --json`

## Approval

`notes create`, `notes update`, `notes delete`, and `notes import` are writes. Confirm mode asks the user to approve each call. Observer mode rejects them. A denial or tool error is authoritative: stop, and do not retry, split the write, or save a local file instead.

`notes list` and `notes get` are read-only.

## Attached markdown

Read an attached markdown file with `attachment list` and `attachment read`, then import that content with `notes import`. For an attached host export, do not import it as a note.
