# Packed SFTP downloads

Packed downloads reduce the per-file transfer overhead when a remote folder
contains many small files. The remote server streams a tar archive over SSH;
Netcatty receives and validates it, then restores the selected files and folders
inside the local destination. The server never creates an archive file.

## Usage

1. Keep **Settings > SFTP > Packed downloads > Pack folders and multiple items
   for download** enabled (the default).
2. Select a folder or multiple items in the remote file list or directory tree
   and choose **Download**.
3. Choose a local destination folder. For example, downloading `compose` into
   `Downloads` produces `Downloads/compose`, including its hidden files and
   empty subdirectories. Multiple selected items appear directly in the chosen
   destination, without an extra enclosing folder.

The transfer center shows one task for the selection, with receiving and
restoring phases, across all open app windows. Cancel from any window stops the
transfer and removes its temporary local data. Packed transfers cannot pause or
resume; after a failure or cancellation, start a new download from the selection.
They continue running during the close/quit confirmation; cancelling that prompt
does not restart or expand the selected download.

If any selected name already exists in the destination, Netcatty offers to
choose another destination folder or cancel. Packed downloads do not silently
replace or merge existing files.

The existing **Folder compression** setting controls uploads independently.
**Compress...** creates an archive that remains on the server; **Download**
uses this temporary transfer format and restores the original layout locally.

## Compatibility and fallback

Packed downloads currently run on macOS and Linux clients. The connection must
allow an SSH command channel and the server must support streaming tar output
(`tar -cf -`). Netcatty uses gzip compression when `tar -czf -` is available;
otherwise it can stream an uncompressed tar archive. Compatibility is checked
on the connected server rather than inferred from its Linux distribution.

Ordinary per-file downloads remain available automatically when the server
cannot pack the selection, including SFTP-only accounts without command access.
Windows clients, single-channel connections, sudo-mode connections and
non-UTF-8 filename encodings also use ordinary downloads. A single regular
file, a selected symbolic link, or directory-tree selections from different
parent directories use the existing download path. Turning the setting off
uses that path for all downloads. A valid parent-relative symbolic link within
selected content (for example, `compose/sub/link -> ../config`) also falls back
to ordinary downloads after the complete archive has been validated.

Archive corruption, an interrupted connection, an unsupported archive entry,
or a local write failure is reported as a failed transfer, rather than starting
another download over the same destination. Unsafe paths and symbolic links
that could escape the selected content are rejected.

## Local staging and cleanup

Netcatty keeps the received archive and extracted contents in a private workspace
inside its managed temporary directory, including a custom location selected in
**Settings > System**. Temporary-directory usage includes these files. Cleanup
skips workspaces owned by a running transfer process.

The temporary disk needs room for both the received archive and its extracted
contents. If the destination is on the same filesystem, validated folders are
published with a rename. On another filesystem, Netcatty copies the validated
contents into exclusively reserved final paths; those paths can be visible while
copying. A failed or cancelled copy removes only the unchanged entries created by
that operation and preserves any concurrently added files.

The workspace is removed after completion, failure or cancellation while the app
is running. Closing the SFTP pane does not interrupt its queued or active
download. Closing, reloading or crashing the owning app window cancels its packed
downloads and releases their connection leases. No archive is created on the
remote server, so there is no remote archive to delete. An abrupt process
termination or power loss can leave local temporary data; after the owning
process exits, **Settings > System** can show and clear that data.
