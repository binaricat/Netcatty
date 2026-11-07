"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_BYTES = 1_048_576;
const MAX_CONVERSATIONS = 64;

// Core-owned AISession documents, outside plugin filesystem/storage roots.
// The caller must authenticate provenance before supplying the opaque owner.
// Native resume identity, compaction and tool history stay in this repository;
// only a separate public projection is returned through the plugin API.
class PluginAgentConversationStore {
  constructor(directory) {
    if (!path.isAbsolute(directory)) throw new TypeError("Absolute host history directory required");
    this.directory = directory;
    this.pending = new Map();
  }

  #ownerDirectory(owner) {
    if (!owner || typeof owner.privateOwner !== "string" || !owner.privateOwner
      || typeof owner.sourceKey !== "string" || !owner.sourceKey) throw new TypeError("Host provenance required");
    return path.join(this.directory, createHash("sha256").update(JSON.stringify([owner.sourceKey, owner.privateOwner])).digest("hex"));
  }

  #filename(owner, id) {
    if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("Invalid owned conversation reference");
    return path.join(this.#ownerDirectory(owner), `${id}.json`);
  }

  async #prepare(owner) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory() || (await fs.lstat(this.directory)).isSymbolicLink()) throw Error("History root unavailable");
    const directory = this.#ownerDirectory(owner);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("History owner unavailable");
    return directory;
  }

  #validate(record) {
    if (!record || typeof record !== "object" || !UUID.test(record.conversationRef)
      || typeof record.id !== "string" || !record.id.startsWith("plugin-agent:")
      || record.scope?.type !== "global" || record.scope.targetId !== undefined
      || typeof record.agentId !== "string" || typeof record.title !== "string" || record.title.length > 160
      || !Array.isArray(record.messages) || record.messages.length > 200
      || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) throw new TypeError("Invalid core Agent history");
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new RangeError("Agent history budget exceeded");
    return text;
  }

  async #serial(owner, operation) {
    const key = this.#ownerDirectory(owner);
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.pending.set(key, current);
    try { return await current; }
    finally { if (this.pending.get(key) === current) this.pending.delete(key); }
  }

  async list(owner, assertCurrent) {
    await assertCurrent();
    const directory = await this.#prepare(owner);
    const files = await fs.readdir(directory);
    const records = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      if (!file.endsWith(".json") || !UUID.test(id)) continue;
      if (records.length >= MAX_CONVERSATIONS) break;
      const record = await this.read(owner, id, assertCurrent);
      if (record) records.push(record);
    }
    await assertCurrent();
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(owner, id, assertCurrent) {
    await assertCurrent();
    const filename = this.#filename(owner, id);
    await this.#prepare(owner);
    let file;
    try {
      // O_NOFOLLOW avoids following a replaced final path. Core owns ancestors.
      const { constants } = require("node:fs");
      file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw Error("Agent history unavailable");
      const record = JSON.parse(await file.readFile("utf8"));
      this.#validate(record);
      if (record.conversationRef !== id) throw Error("Agent history identity mismatch");
      await assertCurrent();
      return record;
    } catch (error) {
      if (error.code === "ENOENT") { await assertCurrent(); return null; }
      throw error;
    } finally { await file?.close(); }
  }

  async save(owner, record, assertCurrent) {
    // Clone/serialize before any await so caller mutation cannot change commit.
    const text = this.#validate(record);
    const id = record.conversationRef;
    return this.#serial(owner, async () => {
      await assertCurrent();
      const directory = await this.#prepare(owner);
      const filename = this.#filename(owner, id);
      const entries = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
      if (!entries.includes(`${id}.json`) && entries.length >= MAX_CONVERSATIONS) throw new RangeError("Agent conversation budget exceeded");
      const temporary = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await assertCurrent();
        await fs.rename(temporary, filename);
      } finally { await fs.rm(temporary, { force: true }); }
    });
  }
}

module.exports = { PluginAgentConversationStore };
