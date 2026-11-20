import assert from "node:assert/strict";
import test from "node:test";

import { findRightToLeftRuns } from "./terminalBidiJoiner";

const slice = (text: string, ranges: [number, number][]) =>
  ranges.map(([start, end]) => text.slice(start, end));

test("pure left-to-right text is left alone", () => {
  assert.deepEqual(findRightToLeftRuns("ls -la /var/log 2>&1 | grep error"), []);
  assert.deepEqual(findRightToLeftRuns("10.0.0.138 (eth0) 100%"), []);
  assert.deepEqual(findRightToLeftRuns(""), []);
});

test("Persian prose is one run so the browser can order and join it", () => {
  const text = "سلام دنیا";
  assert.deepEqual(findRightToLeftRuns(text), [[0, text.length]]);
});

test("Arabic prose keeps its interior spaces and drops trailing ones", () => {
  const text = "مرحبا بالعالم   ";
  assert.deepEqual(slice(text, findRightToLeftRuns(text)), ["مرحبا بالعالم"]);
});

test("a Persian word typed after a shell command is its own run", () => {
  const text = 'echo "سلام"';
  assert.deepEqual(slice(text, findRightToLeftRuns(text)), ["سلام"]);
});

test("numbers inside Persian text stay in the run", () => {
  const text = "قیمت 100 تومان";
  assert.deepEqual(findRightToLeftRuns(text), [[0, text.length]]);
});

test("an IP address after Arabic text belongs to the Arabic run", () => {
  const text = "العنوان 10.0.0.138";
  assert.deepEqual(findRightToLeftRuns(text), [[0, text.length]]);
});

test("Persian digits inside Persian text stay in the run", () => {
  const text = "تعداد ۵۰ فایل";
  assert.deepEqual(findRightToLeftRuns(text), [[0, text.length]]);
});

test("mixed Persian and English splits at the English words", () => {
  const text = "فایل config.yaml پیدا نشد";
  assert.deepEqual(slice(text, findRightToLeftRuns(text)), ["فایل", "پیدا نشد"]);
});

test("English with a Persian phrase in the middle only joins the phrase", () => {
  const text = "Error: فایل پیدا نشد (code 2)";
  assert.deepEqual(slice(text, findRightToLeftRuns(text)), ["فایل پیدا نشد"]);
});

test("brackets around RTL text inside an RTL run are kept with it", () => {
  const text = "مثال (نص) هنا";
  assert.deepEqual(findRightToLeftRuns(text), [[0, text.length]]);
});

test("Hebrew is handled like Arabic", () => {
  const text = "ls שלום עולם";
  assert.deepEqual(slice(text, findRightToLeftRuns(text)), ["שלום עולם"]);
});

test("a single right-to-left character is not worth joining", () => {
  assert.deepEqual(findRightToLeftRuns("a ب c"), []);
});

test("ranges are sorted and do not overlap", () => {
  const text = "الف abc باء def جيم";
  const ranges = findRightToLeftRuns(text);
  assert.deepEqual(slice(text, ranges), ["الف", "باء", "جيم"]);
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i][0] >= ranges[i - 1][1]);
  }
});
