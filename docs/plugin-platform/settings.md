# Plugin settings

Settings > Plugins uses the same sections, divided cards, rows and toggles as
other Netcatty settings. The first two rows open the plugin manager and configure
[local logging](local-logging.md). Logging details live in a standard host dialog;
opening it does not enable saving or verbose diagnostics.

The installed list shows each plugin's icon, name, version, publisher, description,
host-bound source and runtime status. Search filters this metadata. Quick toggles
call the existing host manager, which retains compatibility checks, permission
prompts and runtime lifecycle rules. Failed mutations leave the actual enabled
state visible. A settings button appears only for declared settings or settings
views, and is enabled only when the host exposes those contributions.

## Manual update checks

**Check for updates** reads installed packages, registered sources and each bound
source's catalog through the existing host bridge. It never installs code or
changes permissions. Open **Browse** to review and install an update through the
existing manager flow.

Only a fresh registry response with a published artifact and valid semantic
version counts as checked. Cached, built-in, failed and incomplete responses do
not imply that installed plugins are current. Local, unknown, removed and disabled
sources are not checked. The summary reports checked packages, available updates,
unchecked packages and unavailable sources separately.

The checker matches source ID, kind and origin, then revalidates source, installed
version and archive hash after asynchronous reads. Source or package changes
invalidate displayed results. Checks run only when requested; there is no automatic
checking preference, automatic installation or global pause switch.

## Native acceptance

Use a fresh isolated profile and synthetic plugins. Capture the compact landing
page and logging dialog at normal and narrow window sizes, including keyboard
focus, scrolling, loading, empty and error states. Verify a denied quick-enable
request leaves the switch off, and a successful request shows the real host state.
Open declared plugin settings, switch manager tabs, return to Installed and reopen
the settings. Close the dialog and verify focus returns to its opener.

Run a manual update check against a synthetic source, then an unavailable source;
verify the summary distinguishes unchecked packages and never installs anything.
Complete the separate local-logging acceptance flow, including verbose consent,
native Clear cancellation/confirmation and export. Do not use real logs or
credentials.
