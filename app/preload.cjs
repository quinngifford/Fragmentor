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
  saveLayout: "layout:save",
  emitCode: "codegen:emit",
  revealBlock: "block:reveal",
  revealCode: "code:reveal",
  watchRun: "run:start",
  controlRun: "run:control",
  runEvent: "run:event",
  saveCases: "block:save-cases",
  runCases: "block:run-cases",
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
  saveLayout: (request) => ipcRenderer.invoke(CHANNELS.saveLayout, request),
  emitCode: (dir) => ipcRenderer.invoke(CHANNELS.emitCode, dir),
  revealBlock: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.revealBlock, dir, blockPath),
  revealCode: (dir, file) => ipcRenderer.invoke(CHANNELS.revealCode, dir, file),
  watchRun: (request) => ipcRenderer.invoke(CHANNELS.watchRun, request),
  controlRun: (runId, command) => ipcRenderer.invoke(CHANNELS.controlRun, runId, command),
  onRunEvent: (callback) => {
    ipcRenderer.on(CHANNELS.runEvent, (_event, runId, runEvent) => callback(runId, runEvent));
  },
  saveCases: (request) => ipcRenderer.invoke(CHANNELS.saveCases, request),
  runCases: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.runCases, dir, blockPath),
});
