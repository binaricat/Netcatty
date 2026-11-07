"use strict";

const { OFFICIAL_SOURCE, thirdPartySource, assertSource } = require("./sourceIdentity.cjs");
const PREFERENCE_KEY = "market-sources-v1";

// Only this host service creates source records. Remote catalogs cannot mutate them.
class PluginSourceRegistry {
  constructor(database) { this.database = database; }
  #read() {
    const row = this.database.db.prepare("SELECT value_json FROM plugin_host_preferences WHERE key = ?").get(PREFERENCE_KEY);
    if (!row) return [];
    const values = JSON.parse(row.value_json);
    if (!Array.isArray(values) || values.length > 32) throw new Error("Invalid saved plugin sources");
    const ids = new Set();
    return values.map((value) => {
      const source = assertSource(value);
      if (source.kind !== "third-party" || ids.has(source.id) || typeof value.enabled !== "boolean") throw new Error("Invalid saved plugin source");
      ids.add(source.id);
      return { ...source, enabled: value.enabled };
    });
  }
  #write(values) {
    this.database.db.prepare("INSERT INTO plugin_host_preferences(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
      .run(PREFERENCE_KEY, JSON.stringify(values), this.database.clock());
  }
  list() { return [{ ...OFFICIAL_SOURCE, enabled: true }, ...this.#read()]; }
  get(id) {
    const source = this.list().find((item) => item.id === id);
    if (!source || !source.enabled) throw new Error("This market source was removed or disabled; no alternate source will be used");
    return source;
  }
  add(name, address) {
    const source = thirdPartySource(name, address);
    this.database.transaction(() => {
      const values = this.#read();
      if (values.some((item) => item.id === source.id)) throw new Error("This market source already exists");
      if (values.length >= 32) throw new Error("At most 32 third-party sources are supported");
      this.#write([...values, { ...source, enabled: true }]);
    });
    return this.get(source.id);
  }
  update(id, name, enabled) {
    if (typeof enabled !== "boolean") throw new Error("Source enabled state must be boolean");
    this.database.transaction(() => {
      const values = this.#read();
      const index = values.findIndex((source) => source.id === id);
      if (index < 0) throw new Error("Third-party source does not exist");
      values[index] = { ...thirdPartySource(name, values[index].origin), enabled };
      this.#write(values);
    });
    return this.list().find((source) => source.id === id);
  }
  remove(id) {
    this.database.transaction(() => {
      const values = this.#read();
      if (!values.some((source) => source.id === id)) throw new Error("Third-party source does not exist");
      this.#write(values.filter((source) => source.id !== id));
    });
    // Package lifetime and optional disabling belong to serialized PluginManager.
  }
}
module.exports = { PluginSourceRegistry };
