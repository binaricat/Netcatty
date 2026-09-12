import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(`const ${functionName} = useCallback`);
  assert.notEqual(start, -1, `${functionName} should exist`);

  const nextConst = source.indexOf("\n  const ", start + 1);
  const nextHook = source.indexOf("\n  use", start + 1);
  const candidates = [nextConst, nextHook].filter((index) => index > start);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("host and AI provider deletion use in-app confirmation dialogs", () => {
  const appSource = readProjectFile("application/app/AppSideEffects.tsx");
  // App owns the confirm state; AppShell renders the dialog.
  const appShellSource = readProjectFile("application/app/AppShell.tsx");
  const aiSettingsSource = readProjectFile("components/settings/tabs/SettingsAITab.tsx");

  assert.match(appShellSource, /import \{ ConfirmDialog \} from '\.\.\/\.\.\/components\/ui\/confirm-dialog';/);
  assert.match(appShellSource, /<ConfirmDialog[\s\S]*confirm\.deleteHost/);
  assert.doesNotMatch(functionBody(appSource, "handleDeleteHost"), /window\.confirm|globalThis\.confirm|\bconfirm\(/);

  assert.match(aiSettingsSource, /import \{ ConfirmDialog \} from "\.\.\/\.\.\/ui\/confirm-dialog";/);
  assert.match(aiSettingsSource, /<ConfirmDialog[\s\S]*confirm\.removeProvider/);
  assert.doesNotMatch(functionBody(aiSettingsSource, "handleRemoveProvider"), /window\.confirm|globalThis\.confirm|\bconfirm\(/);

  const cloudSyncControlsSource = readProjectFile("components/cloud-sync/CloudSyncControls.tsx");
  assert.match(cloudSyncControlsSource, /import \{ ConfirmDialog \} from '\.\.\/ui\/confirm-dialog';/);
  assert.match(
    cloudSyncControlsSource,
    /<ConfirmDialog[\s\S]*cloudSync\.provider\.disconnect\.confirmTitle[\s\S]*onDisconnect/,
  );
  assert.doesNotMatch(cloudSyncControlsSource, /window\.confirm|globalThis\.confirm|\bconfirm\(/);
});

test("delete confirmation dialogs constrain long names", () => {
  const confirmDialogSource = readProjectFile("components/ui/confirm-dialog.tsx");
  const vaultDeleteDialogSource = readProjectFile("components/vault/VaultDeleteConfirmDialog.tsx");
  const sftpDialogSource = readProjectFile("components/sftp/SftpPaneDialogs.tsx");
  const sftpClipboardUploadDialogSource = readProjectFile("components/sftp/SftpClipboardUploadDialog.tsx");
  const hostTreeGroupDeleteSource = readProjectFile("components/host/HostTreeGroupDeleteDialog.tsx");
  const vaultViewLayoutSource = readProjectFile("components/vault/VaultViewLayout.tsx");

  assert.match(confirmDialogSource, /DialogTitle className="truncate"/);
  assert.match(confirmDialogSource, /overflow-hidden sm:max-w-\[380px\]/);

  assert.match(vaultDeleteDialogSource, /<span className="min-w-0 truncate">\{title\}<\/span>/);
  assert.match(vaultDeleteDialogSource, /overflow-hidden sm:max-w-\[400px\]/);

  assert.match(sftpDialogSource, /<DialogTitle className="truncate">/);
  assert.match(sftpDialogSource, /<span className="min-w-0 truncate">\{name\}<\/span>/);
  assert.match(sftpDialogSource, /overflow-hidden sm:max-w-sm/);

  assert.match(sftpClipboardUploadDialogSource, /overflow-hidden sm:max-w-md/);
  assert.match(sftpClipboardUploadDialogSource, /<span className="min-w-0 truncate" title=\{file\.name\}>/);
  assert.match(
    sftpClipboardUploadDialogSource,
    /min-w-0 rounded-md border border-border\/60 bg-muted\/30 px-3 py-2 text-sm font-mono break-all \[overflow-wrap:anywhere\]/,
  );

  assert.match(hostTreeGroupDeleteSource, /overflow-hidden sm:max-w-lg/);
  assert.match(hostTreeGroupDeleteSource, /break-words text-sm text-muted-foreground \[overflow-wrap:anywhere\]/);

  assert.match(vaultViewLayoutSource, /overflow-hidden sm:max-w-lg/);
  assert.match(vaultViewLayoutSource, /break-words text-sm text-muted-foreground \[overflow-wrap:anywhere\]/);
});
