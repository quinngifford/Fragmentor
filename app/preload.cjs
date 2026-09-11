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
  readProject: "project:read",
  projectChanged: "project:changed",
  recentProjects: "project:recent",
  exampleProjects: "project:examples",
  writeImpl: "block:write-impl",
  saveLayout: "layout:save",
  emitCode: "codegen:emit",
  revealBlock: "block:reveal",
  runBlock: "block:run",
  saveCases: "block:save-cases",
  runCases: "block:run-cases",
};

contextBridge.exposeInMainWorld("fragmentor", {
  chooseProject: () => ipcRenderer.invoke(CHANNELS.chooseProject),
  newProject: () => ipcRenderer.invoke(CHANNELS.newProject),
  loadProject: (dir) => ipcRenderer.invoke(CHANNELS.loadProject, dir),
  readProject: (dir) => ipcRenderer.invoke(CHANNELS.readProject, dir),
  // Only the folder is passed on, never the event, which would expose the sender.
  onProjectChanged: (callback) => {
    ipcRenderer.on(CHANNELS.projectChanged, (_event, dir) => callback(dir));
  },
  recentProjects: () => ipcRenderer.invoke(CHANNELS.recentProjects),
  exampleProjects: () => ipcRenderer.invoke(CHANNELS.exampleProjects),
  writeImpl: (request) => ipcRenderer.invoke(CHANNELS.writeImpl, request),
  saveLayout: (request) => ipcRenderer.invoke(CHANNELS.saveLayout, request),
  emitCode: (dir) => ipcRenderer.invoke(CHANNELS.emitCode, dir),
  revealBlock: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.revealBlock, dir, blockPath),
  runBlock: (request) => ipcRenderer.invoke(CHANNELS.runBlock, request),
  saveCases: (request) => ipcRenderer.invoke(CHANNELS.saveCases, request),
  runCases: (dir, blockPath) => ipcRenderer.invoke(CHANNELS.runCases, dir, blockPath),
});
