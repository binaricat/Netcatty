import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { installRightClickLongPress, RIGHT_CLICK_LONG_PRESS_MS } from './rightClickLongPress';

for (const nativeTiming of ['press', 'release'] as const) {
  for (const long of [false, true]) {
    test(`${nativeTiming}-time contextmenu: ${long ? 'long' : 'short'} press dispatches once`, (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const dom = new JSDOM('<div id="root"><span></span></div>');
      const root = dom.window.document.querySelector<HTMLElement>('#root')!;
      const target = root.firstElementChild!;
      const dispose = installRightClickLongPress(root, () => true);
      const received: boolean[] = [];
      root.addEventListener('contextmenu', (event) => received.push(event.shiftKey));
      const fire = (type: string) => target.dispatchEvent(new dom.window.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 2, buttons: type === 'mouseup' ? 0 : 2,
      }));
      fire('mousedown');
      if (nativeTiming === 'press') fire('contextmenu');
      assert.deepEqual(received, []);
      t.mock.timers.tick(long ? RIGHT_CLICK_LONG_PRESS_MS : 100);
      fire('mouseup');
      if (nativeTiming === 'release') fire('contextmenu');
      t.mock.timers.tick(1000);
      assert.deepEqual(received, [long]);
      dispose();
      dom.window.close();
    });
  }
}

for (const cancelBy of ['move', 'blur', 'outside-release', 'dispose', 'mouse-mode']) {
  test(`long press cancels on ${cancelBy}`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM('<div id="root"></div>');
    const root = dom.window.document.querySelector<HTMLElement>('#root')!;
    let enabled = true;
    const dispose = installRightClickLongPress(root, () => enabled);
    let menus = 0;
    root.addEventListener('contextmenu', () => menus++);
    root.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 2 }));
    if (cancelBy === 'move') root.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, buttons: 2, clientX: 20 }));
    if (cancelBy === 'blur') dom.window.dispatchEvent(new dom.window.Event('blur'));
    if (cancelBy === 'outside-release') dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, button: 2 }));
    if (cancelBy === 'dispose') dispose();
    if (cancelBy === 'mouse-mode') enabled = false;
    t.mock.timers.tick(1000);
    assert.equal(menus, 0);
    dispose();
    dom.window.close();
  });
}

test('disabled or mouse-owned gestures retain the full original event sequence', () => {
  const dom = new JSDOM('<div></div>');
  const root = dom.window.document.querySelector('div')!;
  const dispose = installRightClickLongPress(root, () => false);
  const received: string[] = [];
  for (const type of ['mousedown', 'contextmenu', 'mouseup']) {
    root.addEventListener(type, () => received.push(type));
    root.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 2 }));
  }
  assert.deepEqual(received, ['mousedown', 'contextmenu', 'mouseup']);
  dispose();
  dom.window.close();
});
