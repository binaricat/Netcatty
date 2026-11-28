import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateRdpFileContent,
  parseRdpFile,
  rdpFileToHostDraft,
} from './rdpFileParser';

const encodeUtf16LeWithBom = (text: string): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
};

test('parseRdpFile parses JumpServer Razor .rdp file with pipe username, loadbalanceinfo, and ignores signature', () => {
  const rdpContent = [
    '\uFEFFfull address:s:razor.example.com:33890',
    'username:s:alice|550e8400-e29b-41d4-a716-446655440000',
    'use redirection server name:i:0',
    'loadbalanceinfo:s:tsv://MS Terminal Services Plugin.1.Desktop',
    'alternate shell:s:||notepad',
    'shell working directory:s:C:\\Users\\Alice',
    'desktopwidth:i:1920',
    'desktopheight:i:1080',
    'session bpp:i:32',
    'dynamic resolution:i:1',
    'redirectclipboard:i:1',
    'audiomode:i:0',
    'enablecredsspsupport:i:1',
    'authentication level:i:0',
    'signscope:s:Full Address,Alternate Full Address',
    'signature:s:AQABAAEAAAD...',
  ].join('\r\n');

  const parsed = parseRdpFile(rdpContent);
  assert.equal(parsed.hostname, 'razor.example.com');
  assert.equal(parsed.port, 33890);
  assert.equal(parsed.username, 'alice|550e8400-e29b-41d4-a716-446655440000');
  assert.equal(parsed.domain, undefined);
  assert.equal(parsed.useRedirectionServerName, false);
  assert.equal(parsed.loadBalanceInfo, 'tsv://MS Terminal Services Plugin.1.Desktop');
  assert.equal(parsed.alternateShell, '||notepad');
  assert.equal(parsed.shellWorkingDir, 'C:\\Users\\Alice');
  assert.equal(parsed.width, 1920);
  assert.equal(parsed.height, 1080);
  assert.equal(parsed.colorDepth, 32);
  assert.equal(parsed.dynamicResolution, true);
  assert.equal(parsed.resolutionMode, 'dynamic');
  assert.equal(parsed.clipboardSync, true);
  assert.equal(parsed.audioEnabled, true);
  assert.equal(parsed.enableCredSspSupport, true);
  assert.equal(parsed.securityMode, 'auto');
  assert.equal(parsed.authenticationLevel, 0);
  assert.equal(parsed.ignoreCertErrors, true);
  assert.equal(parsed.hasSignature, true);
  assert.equal('signature' in parsed.rawProperties, false);
  assert.equal('signscope' in parsed.rawProperties, false);
});

test('parseRdpFile decodes UTF-16LE BOM bytes and latin1-decoded UTF-16LE strings', () => {
  const text = [
    'full address:s:win-server.corp.local',
    'server port:i:0x0d3e',
    'username:s:CORP\\Administrator',
    'remoteapplicationmode:i:1',
    'remoteapplicationprogram:s:||calc',
    'smart sizing:i:1',
    'audiomode:i:2',
    'redirectclipboard:i:0',
    'enablecredsspsupport:i:0',
    'gatewayhostname:s:rdgw.corp.local',
  ].join('\r\n');

  const utf16Bytes = encodeUtf16LeWithBom(text);
  const parsedFromBytes = parseRdpFile(utf16Bytes);
  assert.equal(parsedFromBytes.hostname, 'win-server.corp.local');
  assert.equal(parsedFromBytes.port, 3390);
  assert.equal(parsedFromBytes.username, 'Administrator');
  assert.equal(parsedFromBytes.domain, 'CORP');
  assert.equal(parsedFromBytes.remoteApplicationMode, true);
  assert.equal(parsedFromBytes.remoteApplicationProgram, '||calc');
  assert.equal(parsedFromBytes.resolutionMode, 'fit');
  assert.equal(parsedFromBytes.audioEnabled, false);
  assert.equal(parsedFromBytes.clipboardSync, false);
  assert.equal(parsedFromBytes.securityMode, 'tls');
  assert.equal(parsedFromBytes.gatewayHostname, 'rdgw.corp.local');

  const latin1String = Array.from(utf16Bytes, (b) => String.fromCharCode(b)).join('');
  const parsedFromLatin1 = parseRdpFile(latin1String);
  assert.equal(parsedFromLatin1.hostname, 'win-server.corp.local');
  assert.equal(parsedFromLatin1.port, 3390);
  assert.equal(parsedFromLatin1.domain, 'CORP');
});

test('parseRdpFile supports bracketed IPv6, alternate full address, and pcb', () => {
  const parsed = parseRdpFile([
    'alternate full address:s:[2001:db8::42]:3399',
    'pcb:s:vm-guid-1234',
    'desktopwidth:i:1600',
    'desktopheight:i:900',
    'session bpp:i:24',
  ].join('\n'));

  assert.equal(parsed.hostname, '2001:db8::42');
  assert.equal(parsed.port, 3399);
  assert.equal(parsed.alternateHostname, '2001:db8::42');
  assert.equal(parsed.alternatePort, 3399);
  assert.equal(parsed.pcb, 'vm-guid-1234');
  assert.equal(parsed.resolutionMode, 'fixed');
  assert.equal(parsed.colorDepth, 24);
  assert.equal(parsed.username, '');
});

test('rdpFileToHostDraft produces valid standalone Windows RDP host with no embedded password', () => {
  const parsed = parseRdpFile([
    'full address:s:10.0.0.50:3390',
    'username:s:CONTOSO\\ops',
    'desktopwidth:i:1440',
    'desktopheight:i:900',
  ].join('\r\n'));

  const host = rdpFileToHostDraft(parsed, 'Finance-Win.rdp', { id: 'host-rdp', now: 999 });
  assert.equal(host.id, 'host-rdp');
  assert.equal(host.label, 'Finance-Win');
  assert.equal(host.protocol, 'rdp');
  assert.equal(host.os, 'windows');
  assert.equal(host.hostname, '10.0.0.50');
  assert.equal(host.port, 3390);
  assert.equal(host.username, 'ops');
  assert.deepEqual(host.tags, []);
  assert.equal(host.rdpConfig?.domain, 'CONTOSO');
  assert.equal(host.rdpConfig?.width, 1440);
  assert.equal(host.rdpConfig?.height, 900);
  assert.equal('password' in (host.rdpConfig ?? {}), false);
});

test('generateRdpFileContent round-trips cleanly through parseRdpFile and strips CRLF injection', () => {
  const generated = generateRdpFileContent({
    hostname: '2001:db8::10',
    port: 33890,
    username: 'alice|token-123',
    width: 1920,
    height: 1080,
    colorDepth: 32,
    resolutionMode: 'dynamic',
    audioEnabled: true,
    clipboardSync: true,
    securityMode: 'auto',
    ignoreCertErrors: true,
    loadBalanceInfo: 'tsv://MS Terminal Services Plugin.1.Pool\r\nfull address:s:evil.example',
    alternateShell: '||cmd',
    shellWorkingDir: 'C:\\Work',
  });

  assert.ok(generated.includes('full address:s:[2001:db8::10]:33890\r\n'));
  assert.ok(generated.includes('\r\nuse redirection server name:i:1\r\n'));
  assert.ok(!generated.includes('\r\nfull address:s:evil.example'));
  const reparsed = parseRdpFile(generated);
  assert.equal(reparsed.hostname, '2001:db8::10');
  assert.equal(reparsed.port, 33890);
  assert.equal(reparsed.username, 'alice|token-123');
  assert.equal(reparsed.useRedirectionServerName, true);
  assert.equal(reparsed.resolutionMode, 'dynamic');
  assert.equal(reparsed.audioEnabled, true);
  assert.equal(reparsed.clipboardSync, true);
  assert.equal(reparsed.ignoreCertErrors, true);
  assert.equal(reparsed.alternateShell, '||cmd');
  assert.equal(reparsed.shellWorkingDir, 'C:\\Work');
});
