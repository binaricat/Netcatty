import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createEmptyPane } from "../../application/state/sftp/types";
import type { SftpFileEntry } from "../../types";
import { ContextMenuContent } from "../ui/context-menu";
import { TooltipProvider } from "../ui/tooltip";
import { installDomEnvironment } from "../test-support/renderReactDom";
import { SftpPaneFileList } from "./SftpPaneFileList";
import { useSftpPaneTreeContextMenu } from "./useSftpPaneTreeContextMenu";
import {
  getTerminalPromptDraftContext,
  isTerminalReadyForCommandInjection,
  registerTerminalCommandInjectionReadyReader,
} from "../terminal/runtime/terminalCommandInjectionReadyRegistry";
import { detectPrompt, getPromptLineTextAfterCursor } from "../terminal/autocomplete/promptDetector";
import { isIdleShellReadyForCommandInjection } from "../../domain/terminalCommandInjectionReady";
import { isTerminalDraftContextSafeForPathInsertion } from "../../domain/sftpTerminalPath";
import en from "../../application/i18n/locales/en";
import es from "../../application/i18n/locales/es";
import ru from "../../application/i18n/locales/ru";
import zhCN from "../../application/i18n/locales/zh-CN";
import zhTW from "../../application/i18n/locales/zh-TW";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
environment.IS_REACT_ACT_ENVIRONMENT = true;
after(() => { environment.IS_REACT_ACT_ENVIRONMENT = previous; });

type MenuItem = React.ReactElement<{ children?: React.ReactNode; onClick?: () => void }>;

function collectMenuItems(node: React.ReactNode, out: MenuItem[] = []): MenuItem[] {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(child)) return;
    if (typeof child.props.onClick === "function") {
      out.push(child);
    }
    if (child.props.children) {
      collectMenuItems(child.props.children, out);
    }
  });
  return out;
}

function findMenuAction(children: React.ReactNode, key: string): MenuItem | undefined {
  return collectMenuItems(children).find((item) =>
    React.Children.toArray(item.props.children).includes(key),
  );
}

const folder: SftpFileEntry = {
  name: "docker app",
  type: "directory",
  size: 0,
  sizeFormatted: "0 B",
  lastModified: 0,
  lastModifiedFormatted: "",
};
const file: SftpFileEntry = {
  name: "docker-compose.yml",
  type: "file",
  size: 128,
  sizeFormatted: "128 B",
  lastModified: 0,
  lastModifiedFormatted: "",
};

test("list context menu exposes insert-path for files/folders and cd for folders and background only when paired", async (t) => {
  const dom = installDomEnvironment();
  const noop = () => {};
  const inserted: string[] = [];
  const cdTargets: string[] = [];

  let props: React.ComponentProps<typeof SftpPaneFileList> = {
    t: (key) => key,
    pane: {
      ...createEmptyPane("pane-terminal-path"),
      connection: {
        id: "conn",
        hostId: "host",
        hostLabel: "Host",
        isLocal: false,
        status: "connected",
        currentPath: "/srv/site",
      },
      selectedFiles: new Set<string>(),
      files: [folder, file],
    },
    side: "left",
    isPaneFocused: true,
    sorting: {
      sortField: "name",
      sortOrder: "asc",
      directoriesFirst: true,
      columnWidths: { name: 50, modified: 24, size: 7, type: 9, owner: 10 },
      visibleColumns: { name: true, modified: true, size: true, type: true, owner: true },
      handleSort: noop,
      handleResizeStart: noop,
      toggleColumnVisibility: noop,
      toggleDirectoriesFirst: noop,
    },
    fileListRef: { current: null },
    handleFileListScroll: noop,
    shouldVirtualize: false,
    totalHeight: 0,
    sortedDisplayFiles: [folder, file],
    isDragOverPane: false,
    draggedFiles: null,
    onRefresh: noop,
    onNavigateTo: noop,
    onClearSelection: noop,
    setShowNewFolderDialog: noop,
    setShowNewFileDialog: noop,
    getNextUntitledName: () => "",
    setNewFileName: noop,
    setFileNameError: noop,
    dragOverEntry: null,
    handleRowSelect: noop,
    handleRowOpen: noop,
    handleFileDragStart: noop,
    onDragEnd: noop,
    handleEntryDragOver: noop,
    handleRowDragLeave: noop,
    handleEntryDrop: noop,
    onCopyToOtherPane: noop,
    onMoveEntriesToPath: async () => {},
    openRenameDialog: noop,
    openDeleteConfirm: noop,
    onInsertPathToTerminal: (path) => { inserted.push(path); },
    onCdInTerminal: (dirPath) => { cdTargets.push(dirPath); },
    rowHeight: 28,
    visibleRows: [],
  };

  const render = () => React.createElement(TooltipProvider, null, React.createElement(SftpPaneFileList, props));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(render()); });
  t.after(async () => {
    await act(async () => { renderer.unmount(); });
    dom.cleanup();
    environment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  const menus = () => renderer.root.findAllByType(ContextMenuContent);
  const insertActions = () => menus()
    .map((menu) => findMenuAction(menu.props.children, "sftp.context.insertPathToTerminal"))
    .filter((item): item is MenuItem => Boolean(item));
  const cdActions = () => menus()
    .map((menu) => findMenuAction(menu.props.children, "sftp.context.cdInTerminal"))
    .filter((item): item is MenuItem => Boolean(item));

  // Folder row + file row both have Insert path into terminal.
  assert.equal(insertActions().length, 2);
  insertActions()[0].props.onClick?.();
  insertActions()[1].props.onClick?.();
  assert.deepEqual(inserted, ["/srv/site/docker app", "/srv/site/docker-compose.yml"]);

  // Folder row + empty background menu have Open in terminal (cd); file row does not.
  assert.equal(cdActions().length, 2);
  cdActions()[0].props.onClick?.();
  cdActions()[1].props.onClick?.();
  assert.deepEqual(cdTargets, ["/srv/site/docker app", "/srv/site"]);

  // When unpaired (callbacks omitted), both context actions disappear cleanly.
  props = { ...props, onInsertPathToTerminal: undefined, onCdInTerminal: undefined };
  await act(async () => { renderer.update(render()); });
  assert.equal(insertActions().length, 0);
  assert.equal(cdActions().length, 0);
});

test("tree context menu shows insert-path on files/folders, cd on folders only, and hides on parent entry or unpaired pane", async (t) => {
  const inserted: string[] = [];
  const cdTargets: string[] = [];
  const emptyRef = { current: undefined };

  let props: Parameters<typeof useSftpPaneTreeContextMenu>[0] = {
    contextTarget: { entry: folder, entryPath: "/srv/site/docker app" },
    pane: { connection: { id: "conn", isLocal: false } },
    tRef: { current: (key: string) => key },
    onOpenFileWithSystemDefaultRef: emptyRef,
    onOpenFileWithRef: emptyRef,
    onEditFileRef: emptyRef,
    onDownloadFileRef: emptyRef,
    onExtractArchiveRef: emptyRef,
    onEditPermissionsRef: emptyRef,
    onDuplicateEntriesRef: emptyRef,
    onCreateArchiveRef: emptyRef,
    onInsertPathToTerminal: (path: string) => { inserted.push(path); },
    onCdInTerminal: (dirPath: string) => { cdTargets.push(dirPath); },
    getActionPaths: (path: string) => [path],
  };

  let menu: React.ReactNode;
  function Probe() {
    menu = useSftpPaneTreeContextMenu(props);
    return null;
  }

  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  t.after(async () => { await act(async () => { renderer.unmount(); }); });

  const getAction = (key: string) =>
    findMenuAction((menu as React.ReactElement<{ children: React.ReactNode }>).props.children, key);

  // Directory node: both insert and cd.
  const dirInsert = getAction("sftp.context.insertPathToTerminal");
  const dirCd = getAction("sftp.context.cdInTerminal");
  assert.ok(dirInsert);
  assert.ok(dirCd);
  dirInsert!.props.onClick?.();
  dirCd!.props.onClick?.();
  assert.deepEqual(inserted, ["/srv/site/docker app"]);
  assert.deepEqual(cdTargets, ["/srv/site/docker app"]);

  // File node: insert only, no cd.
  props = { ...props, contextTarget: { entry: file, entryPath: "/srv/site/docker-compose.yml" } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  const fileInsert = getAction("sftp.context.insertPathToTerminal");
  assert.ok(fileInsert);
  assert.equal(getAction("sftp.context.cdInTerminal"), undefined);
  fileInsert!.props.onClick?.();
  assert.deepEqual(inserted, ["/srv/site/docker app", "/srv/site/docker-compose.yml"]);

  // Synthetic parent ".." entry: neither insert nor cd.
  props = { ...props, contextTarget: { entry: { ...folder, name: ".." }, entryPath: "/srv" } };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  assert.equal(getAction("sftp.context.insertPathToTerminal"), undefined);
  assert.equal(getAction("sftp.context.cdInTerminal"), undefined);

  // Unpaired pane: neither insert nor cd.
  props = {
    ...props,
    contextTarget: { entry: folder, entryPath: "/srv/site/docker app" },
    onInsertPathToTerminal: undefined,
    onCdInTerminal: undefined,
  };
  await act(async () => { renderer.update(React.createElement(Probe)); });
  assert.equal(getAction("sftp.context.insertPathToTerminal"), undefined);
  assert.equal(getAction("sftp.context.cdInTerminal"), undefined);
});

test("SftpSidePanel guards terminal path insertion and cd writes and SftpPaneView compares handlers in memo", () => {
  const sidePanelSource = readFileSync(new URL("../SftpSidePanel.tsx", import.meta.url), "utf8");
  const paneViewSource = readFileSync(new URL("./SftpPaneView.tsx", import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");

  assert.match(
    sidePanelSource,
    /const handleInsertPathToTerminal = useCallback\([\s\S]*?isTerminalSensitiveInputActive\(action\.sessionId\)[\s\S]*?isTerminalReadyForCommandInjection\(action\.sessionId, \{ allowDraft: true \}\)[\s\S]*?getTerminalPromptDraftContext\(action\.sessionId\)[\s\S]*?isTerminalDraftContextSafeForPathInsertion\(\{[\s\S]*?shellKind: action\.shellKind[\s\S]*?toast\.warning\(t\("sftp\.terminal\.insertBlockedUnsafeQuote"\), "SFTP"\)[\s\S]*?terminalBackend\.writeToSession\(action\.sessionId, action\.data, \{ automated: true \}\)[\s\S]*?scheduleDeferredTerminalFocus\(onRequestTerminalFocus\)/,
  );
  assert.match(
    sidePanelSource,
    /const handleCdInTerminal = useCallback\([\s\S]*?isTerminalSensitiveInputActive\(action\.sessionId\)[\s\S]*?isTerminalReadyForCommandInjection\(action\.sessionId\)[\s\S]*?terminalBackend\.writeToSession\(action\.sessionId, action\.data, \{ automated: true \}\)[\s\S]*?scheduleDeferredTerminalFocus\(onRequestTerminalFocus\)/,
  );
  assert.match(
    sidePanelSource,
    /onInsertPathToTerminal=\{canSendPathToTerminal \? handleInsertPathToTerminal : undefined\}/,
  );
  assert.match(
    sidePanelSource,
    /onCdInTerminal=\{canSendPathToTerminal \? handleCdInTerminal : undefined\}/,
  );
  assert.match(
    terminalSource,
    /registerTerminalCommandInjectionReadyReader\(\s*sessionId,[\s\S]*?afterCursorInputLength: getPromptLineTextAfterCursor\(term\)\.trim\(\)\.length,[\s\S]*?promptText: prompt\.promptText,\s*userInput: prompt\.userInput,\s*pendingTypedInput: commandBufferRef\.current,/,
  );
  assert.match(paneViewSource, /if \(prev\.onInsertPathToTerminal !== next\.onInsertPathToTerminal\) return false;/);
  assert.match(paneViewSource, /if \(prev\.onCdInTerminal !== next\.onCdInTerminal\) return false;/);
});

test("after-cursor text after Ctrl+A on recalled history blocks idle cd injection (including wrapped lines)", () => {
  const makeTerm = (rows: Array<{ text: string; isWrapped?: boolean }>, cursorY: number, cursorX: number) => ({
    cols: 80,
    buffer: {
      active: {
        baseY: 0,
        cursorY,
        cursorX,
        length: rows.length,
        getLine: (row: number) => {
          const entry = rows[row];
          if (!entry) return undefined;
          return {
            isWrapped: Boolean(entry.isWrapped),
            translateToString: () => entry.text,
          };
        },
      },
    },
  });

  // Recalled `$ rm -rf /tmp/foo` then pressed Ctrl+A (cursor right after `$ `).
  const recalledTerm = makeTerm([{ text: "$ rm -rf /tmp/foo   " }], 0, 2);
  const recalledPrompt = detectPrompt(recalledTerm as never);
  assert.equal(recalledPrompt.isAtPrompt, true);
  assert.equal(recalledPrompt.userInput, "");
  const recalledAfter = getPromptLineTextAfterCursor(recalledTerm as never).trim();
  assert.equal(recalledAfter, "rm -rf /tmp/foo");
  assert.equal(
    isIdleShellReadyForCommandInjection({
      sensitiveInputActive: false,
      hasLiveTerminal: true,
      alternateScreenActive: false,
      isAtPrompt: recalledPrompt.isAtPrompt,
      userInputLength: recalledPrompt.userInput.length,
      pendingTypedInputLength: 0,
      afterCursorInputLength: recalledAfter.length,
    }),
    false,
  );

  // Wrapped command where remainder sits on the wrapped continuation row.
  const wrappedTerm = makeTerm(
    [
      { text: "$ " },
      { text: "rm -rf /tmp/foo", isWrapped: true },
    ],
    0,
    2,
  );
  const wrappedAfter = getPromptLineTextAfterCursor(wrappedTerm as never).trim();
  assert.equal(wrappedAfter, "rm -rf /tmp/foo");
  assert.equal(
    isIdleShellReadyForCommandInjection({
      sensitiveInputActive: false,
      hasLiveTerminal: true,
      alternateScreenActive: false,
      isAtPrompt: true,
      userInputLength: 0,
      pendingTypedInputLength: 0,
      afterCursorInputLength: wrappedAfter.length,
    }),
    false,
  );

  // Clean idle prompt with only padding spaces after cursor stays ready.
  const idleTerm = makeTerm(
    [
      { text: "$        " },
      { text: "unrelated next line", isWrapped: false },
    ],
    0,
    2,
  );
  const idlePrompt = detectPrompt(idleTerm as never);
  const idleAfter = getPromptLineTextAfterCursor(idleTerm as never).trim();
  assert.equal(idleAfter, "");
  assert.equal(
    isIdleShellReadyForCommandInjection({
      sensitiveInputActive: false,
      hasLiveTerminal: true,
      alternateScreenActive: false,
      isAtPrompt: idlePrompt.isAtPrompt,
      userInputLength: idlePrompt.userInput.length,
      pendingTypedInputLength: 0,
      afterCursorInputLength: idleAfter.length,
    }),
    true,
  );
});

test("prompt draft reader blocks insertion when cursor is inside an open double quote and cleans up on unregister", () => {
  const sessionId = "sftp-insert-draft-test";
  let draft = { promptText: "user@host:~$ ", userInput: "cat \"", pendingTypedInput: "cat \"" };
  const unregister = registerTerminalCommandInjectionReadyReader(
    sessionId,
    (options) => Boolean(options?.allowDraft),
    () => draft,
  );

  try {
    assert.equal(isTerminalReadyForCommandInjection(sessionId, { allowDraft: true }), true);
    const unsafeContext = getTerminalPromptDraftContext(sessionId);
    assert.ok(unsafeContext);
    assert.equal(
      isTerminalDraftContextSafeForPathInsertion({ ...unsafeContext!, shellKind: "posix" }),
      false,
    );

    draft = { promptText: "user@host:~$ ", userInput: "cat ", pendingTypedInput: "cat " };
    const safeContext = getTerminalPromptDraftContext(sessionId);
    assert.ok(safeContext);
    assert.equal(
      isTerminalDraftContextSafeForPathInsertion({ ...safeContext!, shellKind: "posix" }),
      true,
    );
  } finally {
    unregister();
  }

  assert.equal(getTerminalPromptDraftContext(sessionId), null);
});

test("all 5 locales define translated labels for SFTP terminal path context menu items and unsafe-quote feedback", () => {
  const keys = [
    "sftp.context.insertPathToTerminal",
    "sftp.context.cdInTerminal",
    "sftp.terminal.insertBlockedUnsafeQuote",
  ] as const;
  const locales = { en, es, ru, "zh-CN": zhCN, "zh-TW": zhTW };

  for (const [locale, messages] of Object.entries(locales)) {
    for (const key of keys) {
      assert.ok(messages[key]?.trim(), `${locale} missing ${key}`);
      if (locale !== "en") {
        assert.notEqual(messages[key], en[key], `${locale} left ${key} untranslated`);
      }
    }
  }
});
