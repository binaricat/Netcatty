# Netcatty Privacy Policy

Effective date: July 27, 2026

This policy applies to the Netcatty desktop application distributed through
the official Netcatty GitHub repository. It does not cover third-party
websites, services, plugins, command-line agents, or servers that you choose to
use with Netcatty.

## Summary

Netcatty does not operate a centralized user account, advertising, analytics,
or crash-reporting service. The Netcatty maintainers do not automatically
receive your saved hosts, credentials, terminal contents, files, chat history,
or diagnostic logs.

Netcatty stores application data on your device by default. It connects to
external services only when required for a feature you use, including update
checks, remote connections, cloud sync, AI providers, and user-installed or
user-configured integrations.

## Data stored on your device

Depending on the features you use, Netcatty may store:

- hosts, groups, usernames, notes, snippets, terminal settings, and workspace
  state;
- passwords, private keys, passphrases, access tokens, and provider
  credentials;
- terminal, file-transfer, editor, and AI conversation state;
- preferences, update settings, permission decisions, and local diagnostic
  information.

Sensitive fields are protected using operating-system-backed storage where it
is available in the packaged desktop application. You remain responsible for
protecting your device, operating-system account, exported backups, and any
unencrypted files that you create or export.

You can remove local Netcatty data by deleting it in the application or by
uninstalling Netcatty and removing its application-data directory. Data kept
by a third-party service must be removed through that service.

## Network connections and third parties

Netcatty sends data directly to third parties in the following situations:

- **Updates:** Netcatty may contact GitHub to check for and download official
  releases. GitHub receives normal connection information such as your IP
  address and request metadata.
- **Remote access and file transfer:** When you connect through SSH, Telnet,
  serial, Mosh, SFTP, SCP, port forwarding, or related tools, connection data,
  terminal input and output, authentication data, and transferred files are
  exchanged with the destination systems that you select. Private keys remain
  on your device unless you explicitly transfer or export them.
- **Cloud sync:** If you enable sync, Netcatty sends an encrypted vault to the
  provider you choose: GitHub Gist, Google Drive, Microsoft OneDrive, WebDAV,
  or an S3-compatible service. Encryption and decryption occur on your device.
  Authentication and account metadata are exchanged with the selected
  provider.
- **AI and agent features:** If you configure or use an AI provider or coding
  agent, prompts, conversation content, selected terminal or workspace
  context, tool inputs and outputs, and related request metadata may be sent to
  that provider. The exact data and retention rules are controlled by the
  provider and your provider account or configuration.
- **Plugins and custom endpoints:** User-installed plugins, custom AI
  endpoints, proxy servers, WebDAV servers, S3-compatible services, and other
  integrations may process data under their own policies.

These services are not operated by the Netcatty maintainers. Review their
privacy policies and terms before enabling the corresponding feature.

## Diagnostics and support

Netcatty does not automatically upload application logs or crash reports to
the maintainers. If you attach logs, screenshots, configuration, or other
diagnostic material to a GitHub issue, discussion, or support request, that
information is shared by your choice and is governed by the service through
which you submit it. Remove passwords, private keys, access tokens, host
details, and other secrets before sharing diagnostic material.

## Changes to this policy

Material changes to this policy will be published in the Netcatty repository.
The effective date at the top of this document identifies the current version.

## Contact

For privacy questions, open a GitHub discussion or contact
`binaricat.io@gmail.com`.
