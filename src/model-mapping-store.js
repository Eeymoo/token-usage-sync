"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeMappings(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  const deduped = new Map();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const alias = typeof item.alias === "string" ? item.alias.trim() : "";
    const target = typeof item.target === "string" ? item.target.trim() : "";
    if (!alias || !target) {
      continue;
    }

    deduped.set(alias, target);
  }

  return Array.from(deduped.entries())
    .map(([alias, target]) => ({ alias, target }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

class ModelMappingStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      updatedAt: null,
      mappings: [],
    };
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) {
      return;
    }

    await this.load();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        updatedAt:
          parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        mappings: normalizeMappings(parsed && parsed.mappings),
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        throw error;
      }
      this.state = {
        updatedAt: null,
        mappings: [],
      };
    }

    this.loaded = true;
  }

  getState() {
    return {
      updatedAt: this.state.updatedAt,
      mappings: this.state.mappings.map((item) => ({ ...item })),
    };
  }

  getTargetModel(alias) {
    if (!alias || typeof alias !== "string") {
      return null;
    }

    const normalized = alias.trim();
    if (!normalized) {
      return null;
    }

    const item = this.state.mappings.find((entry) => entry.alias === normalized);
    return item ? item.target : null;
  }

  async saveMappings(mappings) {
    const normalized = normalizeMappings(mappings);
    const nextState = {
      updatedAt: new Date().toISOString(),
      mappings: normalized,
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");

    this.state = nextState;
    this.loaded = true;
    return this.getState();
  }
}

module.exports = {
  ModelMappingStore,
  normalizeMappings,
};
