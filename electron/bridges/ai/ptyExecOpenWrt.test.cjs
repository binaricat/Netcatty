const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
const { buildLiveShellProbe } = require('./liveShellProbe.cjs');
const { execViaPty } = require('./ptyExec.cjs');

const marker = '__NCMCP_mttikd5b_ccbc892e865a115a80c88afdc77b96a6__';
const reportedCommand = "head -5 /etc/openwrt_release 2>/dev/null; echo '---'; uname -a";
const literal = "quote' \\ $HOME `false` " + '\u4e2d\u6587\ud83d\ude42'.repeat(100);
const cases = [
  [reportedCommand, /DISTRIB_RELEASE='24\.10\.6'/, 0],
  ["printf '%s' \"it's quoted\"", "it's quoted", 0],
  [`cat <<'END_LITERAL'\n${literal}\n\nlast\nEND_LITERAL`, `${literal}\n\nlast`, 0],
  ["printf '%s' '" + 'x'.repeat(340) + "'", 'x'.repeat(340), 0],
  ['printf failed; exit 7', 'failed', 7],
];

test('OpenWrt input lines fit its 512-byte editor, including probe and cleanup', () => {
  for (const source of [buildLiveShellProbe(marker), ...cases.map(([cmd]) => buildWrappedCommand(cmd, 'posix', marker, true))]) {
    for (const line of source.trimEnd().split('\n')) {
      assert.ok(Buffer.byteLength(line) <= 480, `input line has ${Buffer.byteLength(line)} bytes: ${line}`);
      assert.ok(line.includes(marker), 'each continuation must remain hidden by the terminal echo filter');
    }
  }
});

// Point at a disposable OpenWrt 24.10.6 Dropbear instance with blank root
// password enabled (-B). No existing router configuration is read or modified.
test('real OpenWrt Dropbear PTY executes commands with and without the live probe', {
  skip: !process.env.NETCATTY_OPENWRT_SSH_PORT,
  timeout: 60000,
}, async () => {
  const { Client } = require('ssh2');
  const client = new Client();
  await new Promise((resolve, reject) => client.once('ready', resolve).once('error', reject).connect({
    host: '127.0.0.1', port: Number(process.env.NETCATTY_OPENWRT_SSH_PORT), username: 'root', password: '',
  }));
  try {
    for (const probeLiveShell of [false, true]) {
      const stream = await new Promise((resolve, reject) => client.shell({ term: 'xterm', cols: 240, rows: 30 }, (error, value) => error ? reject(error) : resolve(value)));
      try {
        await new Promise((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('OpenWrt prompt missing')), 5000);
          const onData = data => {
            output += data;
            if (output.includes(':~# ')) {
              clearTimeout(timer);
              stream.removeListener('data', onData);
              resolve();
            }
          };
          stream.on('data', onData);
        });
        for (const [command, expected, exitCode] of cases) {
          const result = await execViaPty(stream, command, {
            shellKind: 'posix', probeLiveShell, timeoutMs: 3000,
          });
          assert.equal(result.exitCode, exitCode, JSON.stringify({ probeLiveShell, result }));
          if (typeof expected === 'string') assert.equal(result.stdout, expected);
          else assert.match(result.stdout, expected);
        }
      } finally { stream.close(); }
    }
  } finally { client.end(); }
});
