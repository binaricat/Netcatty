# Host action sample

The sample adds four commands to the command palette. It runs as an offline,
sandboxed browser plugin and requests no network, filesystem, or credential access.

`select` asks Netcatty to share explicitly chosen current hosts. The result contains
saved labels, addresses, usernames, groups, tags, and metadata-only target references.
Group results contain the chosen current members and never include future members.

`create` opens a host-owned SSH draft for `synthetic.invalid`. `edit` proposes a
label change for the first chosen host. Netcatty displays editable fields and the
normalized field diff before either action saves.

`connect` requests a saved-host connection under the plugin's permission settings.
Ask displays the target and whether saved scripts can run; Allow can dispatch
without that permission-only dialog, and Deny blocks the request. Normal SSH
authentication still applies. The acknowledgement contains no session identifier
or terminal data. Selecting metadata does not change those permission settings.

All sample test resources use synthetic hostnames. Native acceptance must use
synthetic hosts and must not establish a real host connection.
