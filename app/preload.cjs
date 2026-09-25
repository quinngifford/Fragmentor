"use strict";

// Written by hand in CommonJS rather than compiled: a sandboxed preload cannot
// be an ES module, and this file is small enough that a build step for it would
// cost more than it saves. It exposes named calls only — never ipcRenderer
// itself — so the page can reach exactly these operations and nothing else.

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  chooseProject: "project:choose",
  newProject: "project:new",
  loadProject: "project:load",
  closeProject: "project:close",
  readProject: "project:read",
  projectChanged: "project:changed",
  recentProjects: "project:recent",
  exampleProjects: "project:examples",
  writeImpl: "block:write-impl",
  emitCode: "codegen:emit",
  revealBlock: "block:reveal",
  revealCode: "code:reveal",
  readCode: "code:read",
  watchRun: "run:start",
  controlRun: "run:control",
  runEvent: "run:event",
  saveCases: "block:save-cases",
  runCases: "block:run-cases",
  blockVersions: "block:versions",
  compareVersion: "block:compare-version",
  swapVersion: "block:swap-version",
  undoSwap: "block:undo-swap",
  saveVersion: "block:save-version",
  deleteSavedVersion: "block:delete-saved-version",
  editSavedVersion: "block:edit-saved-version",
  addNote: "note:add",
  replyToNote: "note:reply",
  resolveNote: "note:resolve",
  deleteNote: "note:delete",
  copyText: "clipboard:write",
  rerunNote: "note:rerun",
  refreshAgentFiles: "project:agent-files",
};

contextBridge.exposeInMainWorld("fragmentor", {
  chooseProject: () => ipcRenderer.invoke(CHANNELS.chooseProject),
  newProject: (settings) => ipcRenderer.invoke(CHANNELS.newProject, settings),
  loadProject: (dir) => ipcRenderer.invoke(CHANNELS.loadProject, dir),
  closeProject: () => ipcRenderer.invoke(CHANNELS.closeProject),
  readProject: (dir) => ipcRenderer.invoke(CHANNELS.readProject, dir),
  // Only the data is passed on, never the event, which would expose the sender.
  onProjectChanged: (callback) => {
    ipcRenderer.on(CHANNELS.projectChanged, (_event, dir) => callback(dir));
  },
  recentProjects: () => ipcRenderer.invoke(CHANNELS.recentProjects),
  exampleProjects: () => ipcRenderer.invoke(CHANNELS.exampleProjects),
  writeImpl: (request) => ipcRenderer.invoke(CHANNELS.writeImpl, request),
  emitCode: (dir) => ipcRenderer.invoke(CHANNELS.emitCode, dir),
  revealBlock: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.revealBlock, dir, blockPath),
  revealCode: (dir, file) => ipcRenderer.invoke(CHANNELS.revealCode, dir, file),
  readCode: (dir, pointer) => ipcRenderer.invoke(CHANNELS.readCode, dir, pointer),
  watchRun: (request) => ipcRenderer.invoke(CHANNELS.watchRun, request),
  controlRun: (runId, command) => ipcRenderer.invoke(CHANNELS.controlRun, runId, command),
  onRunEvent: (callback) => {
    ipcRenderer.on(CHANNELS.runEvent, (_event, runId, runEvent) => callback(runId, runEvent));
  },
  saveCases: (request) => ipcRenderer.invoke(CHANNELS.saveCases, request),
  runCases: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.runCases, dir, blockPath),
  blockVersions: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.blockVersions, dir, blockPath),
  compareVersion: (dir, blockPath, version) => ipcRenderer.invoke(CHANNELS.compareVersion, dir, blockPath, version),
  swapVersion: (dir, blockPath, version) => ipcRenderer.invoke(CHANNELS.swapVersion, dir, blockPath, version),
  undoSwap: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.undoSwap, dir, blockPath),
  saveVersion: (dir, blockPath, name, description) => ipcRenderer.invoke(CHANNELS.saveVersion, dir, blockPath, name, description),
  deleteSavedVersion: (dir, blockPath, id) => ipcRenderer.invoke(CHANNELS.deleteSavedVersion, dir, blockPath, id),
  editSavedVersion: (dir, blockPath, id, name, description) =>
    ipcRenderer.invoke(CHANNELS.editSavedVersion, dir, blockPath, id, name, description),
  addNote: (dir, blockPath, text, extras) => ipcRenderer.invoke(CHANNELS.addNote, dir, blockPath, text, extras),
  replyToNote: (dir, id, text, extras) => ipcRenderer.invoke(CHANNELS.replyToNote, dir, id, text, extras),
  rerunNote: (dir, id) => ipcRenderer.invoke(CHANNELS.rerunNote, dir, id),
  refreshAgentFiles: (dir) => ipcRenderer.invoke(CHANNELS.refreshAgentFiles, dir),
  resolveNote: (dir, id) => ipcRenderer.invoke(CHANNELS.resolveNote, dir, id),
  deleteNote: (dir, id) => ipcRenderer.invoke(CHANNELS.deleteNote, dir, id),
  copyText: (text) => ipcRenderer.invoke(CHANNELS.copyText, text),
});
