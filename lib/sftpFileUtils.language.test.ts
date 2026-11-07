import assert from 'node:assert/strict';
import test from 'node:test';
import { getLanguageId, getLanguageName, getSupportedLanguages } from './sftpFileUtils';

test('recognizes Nginx by filename and recognizable config directories', () => {
  for (const path of [
    'nginx.conf', '/etc/nginx/nginx.conf', '/usr/local/nginx/conf/nginx.conf',
    '/etc/nginx/conf.d/proxy.conf', '/usr/local/etc/nginx/conf.d/site.conf',
    '/usr/local/nginx/conf/conf.d/site.conf', '/etc/nginx/snippets/tls.conf',
    '/etc/nginx/sites-available/default', '/etc/nginx/sites-enabled/example.com',
    'C:\\nginx\\conf.d\\site.conf',
  ]) assert.equal(getLanguageId(path), 'nginx', path);
});

test('keeps ambiguous configs and unrelated languages unchanged', () => {
  for (const path of [
    'site.conf', 'other.conf', '/etc/ssh/sshd.conf', '/etc/conf.d/site.conf',
    '/etc/not-nginx/conf.d/site.conf', '/etc/nginx-not/conf.d/site.conf',
    '/etc/nginx/conf.d/site.conf.bak', '/etc/nginx/conf.d/settings.ini',
  ]) assert.equal(getLanguageId(path), path.endsWith('.bak') ? 'plaintext' : 'ini', path);
  assert.equal(getLanguageId('/folder.with.dots/default'), 'plaintext');
  assert.equal(getLanguageId('/etc/nginx/readme.md'), 'markdown');
  assert.equal(getLanguageId('settings.ini'), 'ini');
});

test('offers Nginx for manual selection without assigning all .conf files to it', () => {
  assert.equal(getLanguageName('nginx'), 'Nginx');
  assert.deepEqual(getSupportedLanguages().filter(({ id }) => id === 'nginx'), [{ id: 'nginx', name: 'Nginx' }]);
  assert.equal(getLanguageId('arbitrary-site.conf'), 'ini');
});
