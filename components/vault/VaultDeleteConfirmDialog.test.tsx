import test from "node:test";
import assert from "node:assert/strict";
import React from "react";

import { VaultDeleteConfirmDialogContent } from "./VaultDeleteConfirmDialog.tsx";

const getElementChildren = (element: React.ReactElement): React.ReactNode =>
  (element.props as { children?: React.ReactNode }).children;

const findElement = (
  node: React.ReactNode,
  predicate: (element: React.ReactElement) => boolean,
): React.ReactElement | null => {
  if (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return null;
  }

  if (React.isValidElement(node)) {
    if (predicate(node)) return node;
    return findElement(getElementChildren(node), predicate);
  }

  const children = React.Children.toArray(node);
  for (const child of children) {
    const found = findElement(child, predicate);
    if (found) return found;
  }

  return null;
};

const findButtonByLabel = (
  root: React.ReactElement,
  label: string,
): React.ReactElement<{ onClick?: () => void; disabled?: boolean }> => {
  const button = findElement(
    root,
    (element) => getElementChildren(element) === label,
  );

  assert.ok(button, `Expected to find button labeled ${label}`);
  return button as React.ReactElement<{ onClick?: () => void; disabled?: boolean }>;
};

test("VaultDeleteConfirmDialogContent cancels without confirming", () => {
  const events: string[] = [];
  const root = VaultDeleteConfirmDialogContent({
    title: 'Delete "Office Key"?',
    description: "This action cannot be undone.",
    cancelLabel: "Cancel",
    confirmLabel: "Delete",
    onCancel: () => events.push("cancel"),
    onConfirm: () => events.push("confirm"),
  }) as React.ReactElement;

  findButtonByLabel(root, "Cancel").props.onClick?.();

  assert.deepEqual(events, ["cancel"]);
});

test("VaultDeleteConfirmDialogContent confirms only from the destructive button", () => {
  const events: string[] = [];
  const root = VaultDeleteConfirmDialogContent({
    title: 'Delete "Office Key"?',
    description: "This action cannot be undone.",
    cancelLabel: "Cancel",
    confirmLabel: "Delete",
    onCancel: () => events.push("cancel"),
    onConfirm: () => events.push("confirm"),
  }) as React.ReactElement;

  findButtonByLabel(root, "Delete").props.onClick?.();

  assert.deepEqual(events, ["confirm"]);
});

test("VaultDeleteConfirmDialogContent disables both actions while busy", () => {
  const root = VaultDeleteConfirmDialogContent({
    title: 'Delete "Forward 8080"?',
    description: "This action cannot be undone.",
    descriptionId: "delete-confirm-description",
    cancelLabel: "Cancel",
    confirmLabel: "Stop & Delete",
    disabled: true,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  }) as React.ReactElement;

  assert.equal(findButtonByLabel(root, "Cancel").props.disabled, true);
  assert.equal(findButtonByLabel(root, "Stop & Delete").props.disabled, true);
  assert.ok(findElement(
    root,
    (element) => (element.props as { id?: string }).id === "delete-confirm-description",
  ));
});
