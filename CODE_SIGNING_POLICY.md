# Netcatty Code Signing Policy

## Status

Netcatty is applying to the SignPath Foundation open-source program. Once the
application and artifact scope are approved, covered Windows release artifacts
will use **Free code signing provided by SignPath.io, certificate by SignPath Foundation**.
Until that approval and integration are complete, Windows release artifacts may
remain unsigned.

SignPath eligibility and the permitted artifact scope are still subject to
SignPath Foundation review, including review of separately licensed third-party
components bundled with optional integrations. Netcatty will not represent an
artifact as SignPath-signed until that review is complete.

## Source and release provenance

- Official source repository:
  [binaricat/Netcatty](https://github.com/binaricat/Netcatty)
- Official releases:
  [GitHub Releases](https://github.com/binaricat/Netcatty/releases)
- Release artifacts are built from the official repository with GitHub
  Actions.
- Signing requests must originate from the approved build workflow and source
  revision.
- A maintainer must approve every production signing request.
- Third-party binaries are outside the Netcatty publisher-signing scope unless
  SignPath Foundation explicitly approves them. They retain their upstream
  signatures or remain unsigned.

## Roles

The project is currently maintained by an individual maintainer.

- Committer and reviewer: [binaricat](https://github.com/binaricat)
- Signing approver: [binaricat](https://github.com/binaricat)

Changes from other contributors are accepted through pull requests and must be
reviewed before merge. Changes to release workflows, signing policy, artifact
configuration, or signing permissions require maintainer review.

## Key protection and revocation

Netcatty maintainers do not receive or store the SignPath Foundation private
key. Signing is performed by SignPath.io under the approved project and
artifact policies.

If a signed artifact, release workflow, maintainer account, or signing request
is suspected to be compromised, the project will stop signing and publishing,
investigate the incident, notify SignPath Foundation, and request revocation
when appropriate.

## Privacy

See the [Netcatty Privacy Policy](PRIVACY.md).
