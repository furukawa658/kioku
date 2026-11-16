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

// ../src/shared/install-port.ts
var install_port_exports = {};
__export(install_port_exports, {
  getDefaultServerPort: () => getDefaultServerPort,
  getDefaultWorkerPort: () => getDefaultWorkerPort,
  getInstallPortOffset: () => getInstallPortOffset
});
module.exports = __toCommonJS(install_port_exports);
var import_crypto = require("crypto");
var import_fs = require("fs");
var import_os2 = require("os");
var import_path2 = require("path");

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

// ../src/shared/install-port.ts
var WORKER_PORT_BASE = 37700;
var SERVER_PORT_BASE = 37877;
var LEGACY_WINDOWS_WORKER_PORT = "37777";
var LEGACY_WINDOWS_PORT_OFFSET = 77;
var LEGACY_WINDOWS_SERVER_PORT = 37954;
function defaultDataDir() {
  return process.env.CLAUDE_MEM_DATA_DIR || (0, import_path2.join)((0, import_os2.homedir)(), ".claude-mem");
}
function readSettings(dataDir) {
  const settingsPath = (0, import_path2.join)(expandHome(dataDir), "settings.json");
  if (!(0, import_fs.existsSync)(settingsPath)) return null;
  try {
    const document = JSON.parse((0, import_fs.readFileSync)(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    const nested = document.env;
    return nested && typeof nested === "object" && !Array.isArray(nested) && Object.keys(nested).some((key) => key.startsWith("CLAUDE_MEM_")) ? nested : document;
  } catch {
    return null;
  }
}
function hasLegacyWindowsWorkerPort(dataDir) {
  return readSettings(dataDir)?.CLAUDE_MEM_WORKER_PORT === LEGACY_WINDOWS_WORKER_PORT;
}
function hasLegacyWindowsServerPort(dataDir) {
  const settings = readSettings(dataDir);
  return ["CLAUDE_MEM_SERVER_URL", "CLAUDE_MEM_SERVER_BETA_URL"].some((key) => {
    const value = settings?.[key];
    if (typeof value !== "string") return false;
    try {
      return new URL(value).port === String(LEGACY_WINDOWS_SERVER_PORT);
    } catch {
      return false;
    }
  });
}
function getInstallPortOffset(dataDir = defaultDataDir(), options = {}) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === void 0 ? typeof process.getuid === "function" ? process.getuid() : null : options.uid;
  if (uid !== null) return (uid % 100 + 100) % 100;
  if (platform === "win32" && hasLegacyWindowsWorkerPort(dataDir)) return LEGACY_WINDOWS_PORT_OFFSET;
  const expandedDataDir = expandHome(dataDir, platform);
  let normalizedDataDir = platform === "win32" ? import_path2.win32.resolve(expandedDataDir) : (0, import_path2.resolve)(expandedDataDir);
  if (platform === "win32") normalizedDataDir = normalizedDataDir.toLowerCase();
  return (0, import_crypto.createHash)("sha256").update(normalizedDataDir, "utf8").digest().readUInt32BE(0) % 100;
}
function getDefaultWorkerPort(dataDir, options) {
  return WORKER_PORT_BASE + getInstallPortOffset(dataDir, options);
}
function getDefaultServerPort(dataDir = defaultDataDir(), options = {}) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === void 0 ? typeof process.getuid === "function" ? process.getuid() : null : options.uid;
  if (platform === "win32" && uid === null && hasLegacyWindowsServerPort(dataDir)) {
    return LEGACY_WINDOWS_SERVER_PORT;
  }
  return SERVER_PORT_BASE + getInstallPortOffset(dataDir, options);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getDefaultServerPort,
  getDefaultWorkerPort,
  getInstallPortOffset
});
