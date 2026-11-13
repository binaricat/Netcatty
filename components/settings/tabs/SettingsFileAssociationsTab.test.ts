import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SettingsFileAssociationsTab.tsx", import.meta.url), "utf8");

test("SFTP settings imports the shared Toggle used by its option rows", () => {
  assert.match(source, /<Toggle\b/);
  assert.match(source, /Toggle,\s*\n\s*Select,/);
});

test("folder compression row exposes its settings search anchor", () => {
  assert.match(
    source,
    /<SettingRow\s+anchorId="sftp-compressed-upload"\s+label=\{t\('settings\.sftp\.compressedUpload\.enable'\)\}/,
  );
});

function functionBody(functionName: string): string {
  const start = source.indexOf(`const ${functionName} = useCallback`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const next = source.indexOf("\n  const ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("removing an SFTP file association confirms with the in-app dialog", () => {
  assert.match(source, /import \{ ConfirmDialog \} from "\.\.\/\.\.\/ui\/confirm-dialog";/);
  assert.doesNotMatch(source, /window\.confirm|globalThis\.confirm|\bconfirm\(/);
  assert.match(
    source,
    /const \[removeConfirmExt, setRemoveConfirmExt\] = useState<string \| null>\(null\);/,
  );

  const handleRemove = functionBody("handleRemove");
  assert.match(handleRemove, /setRemoveConfirmExt\(extension\)/);
  assert.doesNotMatch(handleRemove, /removeAssociation\(/);

  const handleConfirm = functionBody("handleConfirmRemove");
  assert.match(handleConfirm, /if \(!removeConfirmExt\) return;/);
  assert.match(handleConfirm, /removeAssociation\(removeConfirmExt\);\s*setRemoveConfirmExt\(null\);/);

  const dialogStart = source.indexOf("<ConfirmDialog");
  assert.notEqual(dialogStart, -1, "ConfirmDialog should be rendered");
  const dialog = source.slice(dialogStart);
  assert.match(dialog, /open=\{removeConfirmExt !== null\}/);
  assert.match(dialog, /settings\.sftpFileAssociations\.removeConfirm/);
  assert.match(dialog, /confirmLabel=\{t\('action\.remove'\)\}/);
  assert.match(dialog, /\bdestructive\b/);
  assert.match(dialog, /onConfirm=\{handleConfirmRemove\}/);

  const onOpenChange = dialog.slice(dialog.indexOf("onOpenChange"), dialog.indexOf("onConfirm"));
  assert.match(onOpenChange, /if \(!open\) setRemoveConfirmExt\(null\);/);
  assert.doesNotMatch(onOpenChange, /removeAssociation\(/);
});
