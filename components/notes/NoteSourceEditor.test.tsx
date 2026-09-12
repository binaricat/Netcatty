import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  NoteSourceEditor,
  type NoteSourceEditorHandle,
} from "./NoteSourceEditor.tsx";

test("NoteSourceEditor toolbar undo restores coalesced ordinary typing", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const previousAnimationFrame = actEnvironment.requestAnimationFrame;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  actEnvironment.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };

  const editorRef = React.createRef<NoteSourceEditorHandle>();
  const changes: string[] = [];
  const textareaNode = {
    selectionStart: 1,
    selectionEnd: 1,
    focus: () => undefined,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    scrollTop: 0,
    scrollTo: () => undefined,
  };
  let renderer: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = create(
        <NoteSourceEditor
          ref={editorRef}
          noteId="note-1"
          value="a"
          onChange={(nextValue) => changes.push(nextValue)}
        />,
        {
          createNodeMock: (element) => element.type === "textarea"
            ? textareaNode
            : { scrollTop: 0 },
        },
      );
    });

    const textarea = renderer!.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({
        target: { value: "ab" },
        nativeEvent: { inputType: "insertText" },
      });
    });
    await act(async () => {
      textarea.props.onChange({
        target: { value: "abc" },
        nativeEvent: { inputType: "insertText" },
      });
    });
    await act(async () => {
      editorRef.current?.insertAction("undo");
    });

    let prevented = false;
    await act(async () => {
      renderer!.root.findByType("textarea").props.onKeyDown({
        key: "z",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        preventDefault: () => { prevented = true; },
      });
    });
    const composedTextarea = renderer!.root.findByType("textarea");
    await act(async () => {
      composedTextarea.props.onCompositionStart();
      composedTextarea.props.onChange({
        target: { value: "abc你", selectionStart: 4 },
        nativeEvent: { inputType: "insertCompositionText" },
      });
    });
    await act(async () => {
      renderer!.root.findByType("textarea").props.onCompositionEnd();
    });
    await act(async () => {
      renderer!.root.findByType("textarea").props.onCompositionStart();
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: "abc你好", selectionStart: 5 },
        nativeEvent: { inputType: "insertCompositionText" },
      });
    });
    await act(async () => {
      renderer!.root.findByType("textarea").props.onCompositionEnd();
    });
    await act(async () => editorRef.current?.insertAction("undo"));
    await act(async () => editorRef.current?.insertAction("undo"));

    assert.equal(prevented, true);
    assert.deepEqual(changes, ["ab", "abc", "a", "abc", "abc你", "abc你好", "abc你", "abc"]);
    assert.equal(renderer!.root.findByType("textarea").props.value, "abc");
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    actEnvironment.requestAnimationFrame = previousAnimationFrame;
  }
});

test("NoteSourceEditor keeps formatting and later typing as separate undo steps", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const previousAnimationFrame = actEnvironment.requestAnimationFrame;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  actEnvironment.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };

  const editorRef = React.createRef<NoteSourceEditorHandle>();
  const changes: string[] = [];
  const textareaNode = {
    selectionStart: 0,
    selectionEnd: 0,
    focus: () => undefined,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    scrollTop: 0,
    scrollTo: () => undefined,
  };
  let renderer: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = create(
        <NoteSourceEditor
          ref={editorRef}
          noteId="note-1"
          value=""
          onChange={(nextValue) => changes.push(nextValue)}
        />,
        {
          createNodeMock: (element) => element.type === "textarea"
            ? textareaNode
            : { scrollTop: 0 },
        },
      );
    });

    await act(async () => {
      editorRef.current?.insertAction("bold");
    });
    const formatted = "**bold text**";
    const edited = "**bold text!**";
    const textarea = renderer!.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({
        target: { value: edited },
        nativeEvent: { inputType: "insertText" },
      });
    });
    await act(async () => {
      editorRef.current?.insertAction("undo");
    });
    await act(async () => {
      editorRef.current?.insertAction("undo");
    });

    assert.deepEqual(changes, [formatted, edited, formatted, ""]);
    assert.equal(renderer!.root.findByType("textarea").props.value, "");
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    actEnvironment.requestAnimationFrame = previousAnimationFrame;
  }
});

test("NoteSourceEditor undo and redo restore toolbar formatting selections", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const previousAnimationFrame = actEnvironment.requestAnimationFrame;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  actEnvironment.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };

  const editorRef = React.createRef<NoteSourceEditorHandle>();
  const textareaNode = {
    selectionStart: 0,
    selectionEnd: 5,
    focus: () => undefined,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    scrollTop: 0,
    scrollTo: () => undefined,
  };
  let renderer: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = create(
        <NoteSourceEditor
          ref={editorRef}
          noteId="note-1"
          value="hello"
          onChange={() => undefined}
        />,
        {
          createNodeMock: (element) => element.type === "textarea"
            ? textareaNode
            : { scrollTop: 0 },
        },
      );
    });

    await act(async () => editorRef.current?.insertAction("bold"));
    assert.deepEqual(
      { start: textareaNode.selectionStart, end: textareaNode.selectionEnd },
      { start: 2, end: 7 },
    );

    await act(async () => editorRef.current?.insertAction("undo"));
    assert.equal(renderer!.root.findByType("textarea").props.value, "hello");
    assert.deepEqual(
      { start: textareaNode.selectionStart, end: textareaNode.selectionEnd },
      { start: 0, end: 5 },
    );

    await act(async () => editorRef.current?.insertAction("redo"));
    assert.equal(renderer!.root.findByType("textarea").props.value, "**hello**");
    assert.deepEqual(
      { start: textareaNode.selectionStart, end: textareaNode.selectionEnd },
      { start: 2, end: 7 },
    );
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    actEnvironment.requestAnimationFrame = previousAnimationFrame;
  }
});
