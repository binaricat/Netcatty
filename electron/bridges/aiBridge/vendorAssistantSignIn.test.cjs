const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const specs = require("./vendorAssistant/specs.cjs");

function withAccountsFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-vendor-"));
  const file = path.join(dir, "accounts.json");
  fs.writeFileSync(file, JSON.stringify(content), "utf8");
  const previous = process.env.NETCATTY_VENDOR_ACCOUNTS;
  process.env.NETCATTY_VENDOR_ACCOUNTS = file;
  return () => {
    if (previous === undefined) delete process.env.NETCATTY_VENDOR_ACCOUNTS;
    else process.env.NETCATTY_VENDOR_ACCOUNTS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

test("reads a saved account and decodes a base64 password", () => {
  const restore = withAccountsFile({
    vendorAccounts: {
      huawei: { username: "13800000000", password: `b64:${Buffer.from("s3cret").toString("base64")}` },
    },
  });
  try {
    assert.deepEqual(specs.accounts("huawei", os.tmpdir()), { username: "13800000000", password: "s3cret" });
  } finally {
    restore();
  }
});

test("returns null when no file and no fallback match the vendor", () => {
  const restore = withAccountsFile({ vendorAccounts: { huawei: { username: "u", password: "p" } } });
  try {
    assert.equal(specs.accounts("this-vendor-does-not-exist", os.tmpdir()), null);
  } finally {
    restore();
  }
});

test("the sign-in scripts only use plain CSS and text selectors", () => {
  const form = specs.signInFormScript();
  const fill = specs.fillSignInScript("user", "pass");
  for (const script of [form, fill]) {
    assert.doesNotMatch(script, /:has-text\(/);
    assert.match(script, /password/);
  }
  assert.match(fill, /HTMLInputElement\.prototype/);
  assert.match(fill, /dispatchEvent\(new Event\('input'/);
});

test("the submit candidates cover a text button and a form submit", () => {
  assert.ok(specs.SIGN_IN.submit.some((selector) => selector.startsWith("text=")));
  assert.ok(specs.SIGN_IN.submit.includes('button[type="submit"]'));
  assert.ok(specs.SIGN_IN.user.includes("#username"));
});
