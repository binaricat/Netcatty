import assert from 'node:assert/strict';
import test from 'node:test';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';
import { JSDOM } from 'jsdom';
import {
  startSftpFileDrag, takeLocalFileDragSources, getLocalFileDragSources,
  clearLocalFileDrag, clearLocalFileDragForPane, localDragPathKey, localFileDragMoveEffect,
} from './localFileDrag';

function setup(t: test.TestContext) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  const calls: { requestId: string; paths: string[] }[] = [];
  const cancels: string[] = [];
  const errors: string[] = [];
  const remote: unknown[] = [];
  const bridge = {
    startLocalFileDrag: async (payload) => { calls.push(payload); return { started: true }; },
    cancelLocalFileDrag: (id) => cancels.push(id),
    getPathForFile: (file) => (file as unknown as { path: string }).path,
  } as unknown as NetcattyBridge;
  Object.defineProperty(window, "netcatty", { value: bridge, configurable: true });
  t.after(() => {
    clearLocalFileDrag();
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const transfer = (paths: string[] = []) => ({
    types: ['Files'], files: paths.map((path) => ({ path })),
    effectAllowed: '', setData: (...args: string[]) => remote.push(args),
  }) as unknown as DataTransfer;
  const sources = [
    { name: 'certificate.txt', sourcePath: '/local', sourceConnectionId: 'local', isDirectory: false },
    { name: 'folder', sourcePath: '/another path', sourceConnectionId: 'local', isDirectory: true },
  ];
  let prevented = 0;
  const start = (isLocal: boolean | undefined = true, selection = sources) => startSftpFileDrag({
    event: { dataTransfer: transfer(), preventDefault: () => { prevented++; } },
    paneId: 'pane', connection: { id: 'local', isLocal }, sources: selection, side: 'left',
    onRemoteDrag: (...args) => remote.push(args), onError: (error) => errors.push(error),
  });
  return { calls, cancels, errors, remote, transfer, sources, start, prevented: () => prevented, dom };
}

test('local multi-selection retains individual tree paths and never exports plain text', async (t) => {
  const h = setup(t);
  h.start();
  assert.equal(h.prevented(), 1);
  assert.equal(h.remote.length, 0);
  assert.deepEqual(h.calls[0].paths, ['/local/certificate.txt', '/another path/folder']);
  const payload = h.transfer([...h.calls[0].paths].reverse());
  assert.equal(getLocalFileDragSources(payload)?.length, 2);
  assert.deepEqual(takeLocalFileDragSources(payload), h.sources.map((source) => ({ ...source, side: 'left' })));
  assert.equal(takeLocalFileDragSources(payload), null, 'a native gesture is consumed exactly once');
  assert.equal(getLocalFileDragSources(payload), null);
});

test('remote origin preserves HTML payload and callbacks, including absent isLocal', (t) => {
  const h = setup(t);
  h.start(false);
  assert.equal(h.prevented(), 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.remote, [['text/plain', 'certificate.txt\nfolder'], [h.sources, 'left']]);
  startSftpFileDrag({ event: { dataTransfer: h.transfer(), preventDefault: () => assert.fail('remote drag canceled') },
    paneId: 'remote', connection: { id: 'remote' }, sources: h.sources, side: 'right',
    onRemoteDrag: () => {}, onError: assert.fail });
  assert.equal(h.calls.length, 0);
});

test('unrelated external files cannot reuse a previous local gesture', (t) => {
  const h = setup(t);
  h.start();
  assert.equal(takeLocalFileDragSources(h.transfer(['/different/certificate.txt'])), null);
  assert.equal(getLocalFileDragSources(h.transfer()), null);
  h.start();
  assert.equal(takeLocalFileDragSources(h.transfer(['/local/certificate.txt'])), null, 'partial selection is not an internal transfer');
});

test('local failure cancels without text fallback and stale async errors cannot clear a newer gesture', async (t) => {
  const h = setup(t);
  let reject!: (error: Error) => void;
  netcattyBridge.require().startLocalFileDrag = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  h.start();
  const oldReject = reject;
  h.start();
  oldReject(new Error('obsolete'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.errors.length, 0);
  assert.ok(getLocalFileDragSources(h.transfer()));
  reject(new Error('file disappeared'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.errors, ['file disappeared']);
  assert.equal(getLocalFileDragSources(h.transfer()), null);
  assert.equal(h.remote.length, 0);
});

test('native state is cleared on physical cancellation, external completion, connection disposal and new gestures', async (t) => {
  const h = setup(t);
  for (const event of [new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' }),
    new h.dom.window.MouseEvent('mousemove', { buttons: 0 }), new h.dom.window.MouseEvent('mousedown'),
    new h.dom.window.Event('blur'), new h.dom.window.Event('pagehide')]) {
    h.start();
    await Promise.resolve();
    window.dispatchEvent(event);
    assert.equal(getLocalFileDragSources(h.transfer()), null, event.type);
  }
  h.start();
  clearLocalFileDragForPane('another-pane');
  assert.ok(getLocalFileDragSources(h.transfer()));
  clearLocalFileDragForPane('pane');
  assert.equal(getLocalFileDragSources(h.transfer()), null);
  h.start();
  h.start(false);
  assert.equal(getLocalFileDragSources(h.transfer()), null);
});

test('invalid local selections and missing bridge are rejected; parent entry is excluded', (t) => {
  const h = setup(t);
  h.start(true, [{ ...h.sources[0], name: '..' }]);
  assert.equal(h.calls.length, 0);
  h.start(true, [{ ...h.sources[0], sourceConnectionId: 'remote' }]);
  assert.equal(h.calls.length, 0);
  h.start(true, [h.sources[0], { ...h.sources[0], name: '..' }]);
  assert.deepEqual(h.calls[0].paths, ['/local/certificate.txt']);
  netcattyBridge.require().startLocalFileDrag = undefined;
  h.start();
  assert.equal(h.errors.length, 3);
  assert.equal(h.remote.length, 0);
});

test('path matching preserves POSIX whitespace, Unicode and backslashes, and accepts Windows separators', () => {
  assert.equal(localDragPathKey('C:\\Users\\david\\certificate.pem'), 'C:/Users/david/certificate.pem');
  assert.equal(localDragPathKey('\\\\server\\share\\folder'), '//server/share/folder');
  assert.equal(localDragPathKey('/local/é \\name '), '/local/é \\name ');
  assert.notEqual(localDragPathKey('/local/A'), localDragPathKey('/local/a'));
});


test('local move accepts the copy-only native transport on Windows/Linux without changing the operation', () => {
  assert.equal(localFileDragMoveEffect({ effectAllowed: 'copyLink' }), 'copy');
  assert.equal(localFileDragMoveEffect({ effectAllowed: 'copy' }), 'copy');
  assert.equal(localFileDragMoveEffect({ effectAllowed: 'all' }), 'move');
  assert.equal(localFileDragMoveEffect({ effectAllowed: 'copyMove' }), 'move');
});

test('native drop cleanup survives the browser microtask checkpoint before React receives the drop', async (t) => {
  const h = setup(t);
  h.start();
  window.dispatchEvent(new h.dom.window.Event('drop'));
  // Unlike dispatchEvent in jsdom, native browser events can drain microtasks
  // after the window capture callback, before the React root bubble callback.
  await Promise.resolve();
  assert.ok(getLocalFileDragSources(h.transfer()), 'capture must not erase native identity before React handles drop');
  assert.deepEqual(takeLocalFileDragSources(h.transfer(h.calls[0].paths)), h.sources.map(source => ({ ...source, side: 'left' })));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(getLocalFileDragSources(h.transfer()), null);

  h.start();
  window.dispatchEvent(new h.dom.window.Event('drop'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(getLocalFileDragSources(h.transfer()), null, 'unhandled drops also release the gesture');
});
