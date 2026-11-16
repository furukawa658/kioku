"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../src/shared/data-dir.ts
var data_dir_exports = {};
__export(data_dir_exports, {
  resolveDataDir: () => resolveDataDir
});
module.exports = __toCommonJS(data_dir_exports);
var import_fs2 = require("fs");
var import_os2 = require("os");
var import_path2 = require("path");

// ../src/shared/atomic-json.ts
var import_fs = require("fs");

// ../src/shared/hook-io.ts
var pendingModelContext = Promise.resolve();

// ../src/shared/atomic-json.ts
var IS_WINDOWS_PLATFORM = process.platform === "win32";
function stripUtf8Bom(raw) {
  return raw.replace(/^\uFEFF/, "");
}
function parseJsonWithBom(raw) {
  return JSON.parse(stripUtf8Bom(raw));
}
function readJsonFileWithBom(filepath) {
  return parseJsonWithBom((0, import_fs.readFileSync)(filepath, "utf-8"));
}

// ../src/shared/expand-home.ts
var import_os = require("os");
var import_path = require("path");
function expandHome(filePath, platform = process.platform, home = (0, import_os.homedir)()) {
  if (typeof filePath !== "string" || filePath.length === 0) return filePath;
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || platform === "win32" && filePath.startsWith("~\\")) {
    return (0, import_path.join)(home, filePath.slice(2));
  }
  return filePath;
}

// ../src/shared/settings-document-shape.ts
var isSettingsRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function classifySettingsDocument(document) {
  const env = document.env;
  return isSettingsRecord(env) && Object.keys(env).some((key) => key.startsWith("CLAUDE_MEM_")) ? "nested" : "flat";
}
function settingsTarget(document) {
  return classifySettingsDocument(document) === "nested" ? document.env : document;
}

// ../src/shared/data-dir.ts
function resolveDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  }
  const defaultDataDir = (0, import_path2.join)((0, import_os2.homedir)(), ".claude-mem");
  const settingsPath = (0, import_path2.join)(defaultDataDir, "settings.json");
  try {
    if ((0, import_fs2.existsSync)(settingsPath)) {
      const raw = readJsonFileWithBom(settingsPath);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultDataDir;
      const settings = settingsTarget(raw);
      if (typeof settings.CLAUDE_MEM_DATA_DIR === "string" && settings.CLAUDE_MEM_DATA_DIR) {
        return expandHome(settings.CLAUDE_MEM_DATA_DIR);
      }
    }
  } catch {
  }
  return defaultDataDir;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  resolveDataDir
});
