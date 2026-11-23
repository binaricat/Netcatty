const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const specs = require("./vendorAssistant/specs.cjs");
const driver = require("./vendorAssistant/driver.cjs");
const cdp = require("./vendorAssistant/cdp.cjs");

test("resolve accepts keys, names and Chinese aliases", () => {
  assert.equal(specs.resolve("ruijie").key, "ruijie");
  assert.equal(specs.resolve("锐捷").key, "ruijie");
  assert.equal(specs.resolve("华三").key, "h3c");
  assert.equal(specs.resolve("Huawei").key, "huawei");
  assert.equal(specs.resolve("unknown-vendor"), null);
  assert.deepEqual(
    specs.VENDORS.map((v) => v.key),
    ["huawei", "ruijie", "h3c", "juniper", "aruba", "cisco"],
  );
});

test("cleanAnswer drops the echoed question and status prefixes", () => {
  const question = "锐捷交换机怎么查看接口光功率";
  const raw = [
    question,
    "阿在已完成",
    "show interfaces transceiver diagnosis",
    "参考 3 篇资料",
  ].join("\n");
  const cleaned = driver.cleanAnswer(raw, question);
  assert.ok(cleaned.startsWith("show interfaces transceiver diagnosis"));
  assert.ok(!cleaned.includes("阿在已完成"));
  assert.ok(!cleaned.includes(question));
});

test("cleanAnswer keeps a body that merely mentions the question later", () => {
  const question = "怎么配置端口镜像";
  const raw = "先进入全局配置：\nmonitor session 1 source interface gi0/1 both\n怎么配置端口镜像 这个问题的答案见上。";
  const cleaned = driver.cleanAnswer(raw, question);
  assert.ok(cleaned.includes("monitor session 1"));
});

test("isHandoff flags short hand-off replies only", () => {
  assert.equal(driver.isHandoff("抱歉，您反复询问端口镜像配置，需要我帮您转接人工工程师吗？"), true);
  assert.equal(driver.isHandoff("非常抱歉，暂时无法回答。"), true);
  assert.equal(
    driver.isHandoff(
      "配置端口镜像：\nmonitor session 1 source interface gigabitEthernet 0/25 both\nmonitor session 1 destination interface gigabitEthernet 0/26\n用 show monitor 验证。",
    ),
    false,
  );
  assert.equal(driver.isHandoff(""), false);
  assert.equal(driver.isHandoff(null), false);
});

test("cleanAnswer truncates from the last question echo", () => {
  const question = "锐捷交换机怎么配置链路聚合";
  const raw = [
    question,
    "上一次的回答：参考值 4096",
    question,
    "本轮的答案：interface range gi0/1-2",
  ].join("\n");
  const cleaned = driver.cleanAnswer(raw, question);
  assert.ok(cleaned.startsWith("本轮的答案"));
  assert.ok(!cleaned.includes("上一次的回答"));
});

test("status codes stay unique and ok is zero", () => {
  const codes = Object.values(driver.STATUS_CODES);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(driver.STATUS_CODES.ok, 0);
  assert.equal(driver.STATUS_CODES.no_answer, 8);
});

test("login state is derived from the marker file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-vendor-state-"));
  try {
    assert.equal(specs.loginState("ruijie", root).state, "missing");
    fs.mkdirSync(path.join(root, "ruijie"), { recursive: true });
    assert.equal(specs.loginState("ruijie", root).state, "unknown");
    specs.markLoggedIn("ruijie", root);
    assert.equal(specs.loginState("ruijie", root).state, "logged");
    fs.rmSync(path.join(root, "ruijie", specs.LOGIN_MARKER));
    assert.equal(specs.loginState("ruijie", root).state, "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sanitizeQuestion caps length and strips control characters", () => {
  const long = "锐".repeat(900);
  assert.ok(driver.sanitizeQuestion(long).length <= 500);
  assert.equal(driver.sanitizeQuestion("a\u0000b\u0007c"), "a b c");
});

test("probe script targets the vendor's composer and answer selectors", () => {
  const huawei = specs.VENDORS.find((v) => v.key === "huawei");
  const script = specs.probeScript(huawei);
  assert.ok(script.includes("div.multi-input"), "composer selector is embedded");
  assert.ok(script.includes("div.gptContent"), "answer selector is embedded");
  assert.ok(script.includes("hasBox"), "probe reports whether the composer exists");
});

test("cdp readActivePort tolerates a missing profile", () => {
  assert.throws(() => cdp.readActivePort(path.join(os.tmpdir(), "netcatty-missing-profile")));
});
