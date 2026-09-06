# Local transfer publication safety audit

## Confirmed defect

The completed download moves an existing destination to a backup, checks that
its pathname is unoccupied, then renames the prepared download into place.
Another program can save to that pathname between the check and rename. The
rename overwrites those bytes and successful cleanup deletes the original
backup. Backup restoration and post-publication rollback have equivalent races.

Real filesystem regressions inject concurrent creation at the actual final
publication and restoration boundary. Both lose concurrent contents on the
baseline. An explicitly absent destination can also appear after validation and
be incorrectly moved aside. These tests fail before the change.

## Contract and design

- Prepared data and an original backup remain private sibling files.
- Publication and backup restoration use the same no-overwrite primitive.
- On hardlink-capable filesystems, linking publishes complete bytes atomically.
- On filesystems without that operation, exclusive open plus writes through the
  owned handle preserves compatibility without overwriting another destination.
  This fallback exposes partial contents during copying; it does not promise
  atomic visibility. It never deletes the destination pathname on failure.
- Failed fallback copies retain complete prepared data and original backup, with
  their locations in the error. A concurrent replacement is never removed.
- Successful publication is the commit boundary. Cancellation checked before it
  restores the original where possible. Cancellation arriving after publication
  does not attempt unsafe pathname-based rollback.
- A validated absent target is distinct from an omitted validation callback.
- This change does not claim to prevent another program writing through an
  already-open handle or provide durable power-loss transactions.

## Validation

The focused tests cover publication and restoration boundary races, absent
validation, normal mode-preserving replacement, early/late cancellation,
unsupported-hardlink fallback and write failure with concurrent replacement.
Real unsupported-filesystem hardware has not been exercised; the fallback uses
real files with hardlink capability failure injected.

Related audit themes: #3186 replacement attributes and #3213 interrupted recovery.
These reports do not establish the cause of this separately reproduced defect.
