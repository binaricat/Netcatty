import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline copy of extractRootPathsFromClipboardFiles for standalone test
function extractRootPathsFromClipboardFiles(
  files: Array<{ path: string; name: string; isDirectory: boolean; size?: number }>,
): string[] {
  const paths: string[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    const fullPath = file.path;
    if (!fullPath || seenPaths.has(fullPath)) continue;
    paths.push(fullPath.includes(' ') ? `"${fullPath}"` : fullPath);
    seenPaths.add(fullPath);
  }
  return paths;
}

describe('extractRootPathsFromClipboardFiles', () => {
  it('single file path', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([{
        path: '/home/user/file.txt', name: 'file.txt', isDirectory: false, size: 100,
      }]),
      ['/home/user/file.txt'],
    );
  });

  it('multiple files', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([
      { path: '/home/a.txt', name: 'a.txt', isDirectory: false, size: 10 },
      { path: '/home/b.txt', name: 'b.txt', isDirectory: false, size: 20 },
    ]),
    ['/home/a.txt', '/home/b.txt'],
  );
  });

  it('quotes paths with spaces', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([{
        path: '/home/user/my file.txt', name: 'my file.txt', isDirectory: false, size: 100,
      }]),
      ['"/home/user/my file.txt"'],
    );
  });

  it('deduplicates', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([
        { path: '/home/file.txt', name: 'file.txt', isDirectory: false, size: 10 },
        { path: '/home/file.txt', name: 'file.txt', isDirectory: false, size: 10 },
      ]),
      ['/home/file.txt'],
    );
  });

  it('handles directory entries', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([{
        path: '/home/myfolder', name: 'myfolder', isDirectory: true, size: 0,
      }]),
      ['/home/myfolder'],
    );
  });

  it('filters out empty paths', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([{
        path: '', name: 'empty', isDirectory: false,
      }]),
      [],
    );
  });

  it('Windows-style paths', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([{
        path: 'C:\\Users\\test\\file.txt', name: 'file.txt', isDirectory: false, size: 100,
      }]),
      ['C:\\Users\\test\\file.txt'],
    );
  });

  it('empty list', () => {
    assert.deepEqual(extractRootPathsFromClipboardFiles([]), []);
  });

  it('multiple spaced paths', () => {
    assert.deepEqual(
      extractRootPathsFromClipboardFiles([
        { path: '/home/user/a b.txt', name: 'a b.txt', isDirectory: false, size: 10 },
        { path: '/home/user/c d.txt', name: 'c d.txt', isDirectory: false, size: 20 },
      ]),
      ['"/home/user/a b.txt"', '"/home/user/c d.txt"'],
    );
  });
});
