import { spawnSync } from "node:child_process";
import { readState } from "./state.js";
import type { DuoProcess, DuoState } from "./types.js";

export interface WatchSnapshot {
  state: DuoState;
  processes: Array<{
    process: DuoProcess;
    output: string;
  }>;
  capturedAt: string;
  recentWindowMs?: number;
  includeAll?: boolean;
  includeRoots?: boolean;
}

export function readWatchSnapshot(
  projectRoot: string,
  options: { lines: number; includeAll?: boolean; includeRoots?: boolean; recentWindowMs?: number }
): WatchSnapshot {
  const state = readState(projectRoot);
  const recentWindowMs = options.recentWindowMs ?? 2 * 60 * 1000;
  const now = Date.now();
  const selected = orderProcessesForWatch(
    Object.values(state.processes)
    .filter((processRecord) => shouldShowInWatch(processRecord, {
      includeAll: options.includeAll,
      includeRoots: options.includeRoots,
      recentWindowMs,
      now
    }))
  )
    .map((processRecord) => ({
      process: processRecord,
      output: peekProcessOutput(processRecord, options.lines)
    }));

  return {
    state,
    processes: selected,
    capturedAt: new Date().toISOString(),
    recentWindowMs,
    includeAll: options.includeAll,
    includeRoots: options.includeRoots
  };
}

export function renderWatchFrame(snapshot: WatchSnapshot): string {
  return renderWatchFrameWithLayout(snapshot, {
    layout: "stack",
    terminalWidth: 160
  });
}

export function renderWatchFrameWithLayout(
  snapshot: WatchSnapshot,
  options: { layout: "stack" | "columns"; terminalWidth: number }
): string {
  const visibleProcessIds = new Set(snapshot.processes.map(({ process }) => process.id));
  const knownProcessIds = new Set(Object.keys(snapshot.state.processes));
  const header = [
    "duo watch",
    `captured: ${snapshot.capturedAt}`,
    `brake: ${snapshot.state.brake?.active ? snapshot.state.brake.reason : "off"}`,
    `visible_processes: ${snapshot.processes.length}`,
    `scope: ${describeWatchScope(snapshot)}`
  ].join(" | ");

  if (snapshot.processes.length === 0) {
    return `${header}\n\nNo visible duo processes.\n`;
  }

  if (options.layout === "columns" && snapshot.processes.length >= 2 && !hasVisibleHierarchy(snapshot.processes, visibleProcessIds)) {
    return renderColumnsFrame(snapshot, header, options.terminalWidth);
  }

  const sections = snapshot.processes.map(({ process, output }) => {
    const body = output.trim() || "[no captured output yet]";
    return [
      "=".repeat(80),
      describeProcessForWatch(process, visibleProcessIds, knownProcessIds, snapshot),
      "-".repeat(80),
      body
    ].join("\n");
  });

  return `${header}\n\n${sections.join("\n\n")}\n`;
}

export function clearTerminal(): void {
  process.stdout.write("\u001Bc");
}

export function shouldShowInWatch(
  processRecord: DuoProcess,
  options: { includeAll?: boolean; includeRoots?: boolean; recentWindowMs: number; now: number }
): boolean {
  if (options.includeAll) {
    return true;
  }
  if (!processRecord.parentId && !options.includeRoots) {
    return false;
  }
  if (processRecord.status === "running" || processRecord.status === "blocked") {
    return true;
  }
  const updatedAt = Date.parse(processRecord.updatedAt);
  return Number.isFinite(updatedAt) && options.now - updatedAt <= options.recentWindowMs;
}

function peekProcessOutput(processRecord: DuoProcess, lines: number): string {
  const captured = spawnSync("tmux", ["capture-pane", "-t", processRecord.tmuxSession, "-p", "-S", `-${lines}`], {
    encoding: "utf8"
  });
  if (captured.status !== 0) {
    return "[tmux session unavailable]";
  }
  return captured.stdout;
}

function renderColumnsFrame(snapshot: WatchSnapshot, header: string, terminalWidth: number): string {
  const selected = snapshot.processes.slice(0, 2);
  const gap = "  ";
  const columnWidth = Math.max(40, Math.floor((terminalWidth - gap.length) / 2));
  const visibleProcessIds = new Set(snapshot.processes.map(({ process }) => process.id));
  const knownProcessIds = new Set(Object.keys(snapshot.state.processes));

  const columns = selected.map(({ process, output }) => {
    const title = describeProcessForWatch(process, visibleProcessIds, knownProcessIds, snapshot, {
      compact: true
    });
    const body = (output.trim() || "[no captured output yet]").split("\n");
    return fitBlock([title, "-".repeat(Math.max(10, columnWidth - 2)), ...body], columnWidth);
  });

  const maxLines = Math.max(columns[0].length, columns[1].length);
  const rows: string[] = [`${header}\n`];
  for (let index = 0; index < maxLines; index += 1) {
    const left = columns[0][index] || "".padEnd(columnWidth, " ");
    const right = columns[1][index] || "".padEnd(columnWidth, " ");
    rows.push(`${left}${gap}${right}`);
  }

  if (snapshot.processes.length > 2) {
    const rest = snapshot.processes
      .slice(2)
      .map(({ process }) => `${process.name} (${process.runtime}, ${process.status})`)
      .join(", ");
    rows.push("");
    rows.push(`more processes: ${rest}`);
  }

  rows.push("");
  return rows.join("\n");
}

function fitBlock(lines: string[], width: number): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const normalized = line.replace(/\t/g, "    ");
    if (normalized.length === 0) {
      output.push("".padEnd(width, " "));
      continue;
    }
    for (const segment of wrapLine(normalized, width)) {
      output.push(segment.padEnd(width, " "));
    }
  }
  return output;
}

function wrapLine(line: string, width: number): string[] {
  const output: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(" ", width);
    if (breakAt <= 0) {
      breakAt = width;
    }
    output.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt).trimStart();
  }
  output.push(rest);
  return output;
}

function orderProcessesForWatch(processes: DuoProcess[]): DuoProcess[] {
  const processMap = new Map(processes.map((processRecord) => [processRecord.id, processRecord]));
  const children = new Map<string, DuoProcess[]>();

  for (const processRecord of processes) {
    if (!processRecord.parentId || !processMap.has(processRecord.parentId)) {
      continue;
    }
    const bucket = children.get(processRecord.parentId) || [];
    bucket.push(processRecord);
    children.set(processRecord.parentId, bucket);
  }

  const ordered: DuoProcess[] = [];
  const visited = new Set<string>();
  const roots = processes
    .filter((processRecord) => !processRecord.parentId || !processMap.has(processRecord.parentId))
    .sort(byCreatedAt);

  for (const root of roots) {
    appendProcessTree(root, children, visited, ordered);
  }

  for (const processRecord of processes.sort(byCreatedAt)) {
    if (!visited.has(processRecord.id)) {
      appendProcessTree(processRecord, children, visited, ordered);
    }
  }

  return ordered;
}

function appendProcessTree(
  processRecord: DuoProcess,
  children: Map<string, DuoProcess[]>,
  visited: Set<string>,
  ordered: DuoProcess[]
): void {
  if (visited.has(processRecord.id)) {
    return;
  }
  visited.add(processRecord.id);
  ordered.push(processRecord);
  for (const child of (children.get(processRecord.id) || []).sort(byCreatedAt)) {
    appendProcessTree(child, children, visited, ordered);
  }
}

function hasVisibleHierarchy(processes: WatchSnapshot["processes"], visibleProcessIds: Set<string>): boolean {
  return processes.some(({ process }) => Boolean(process.parentId && visibleProcessIds.has(process.parentId)));
}

function describeProcessForWatch(
  processRecord: DuoProcess,
  visibleProcessIds: Set<string>,
  knownProcessIds: Set<string>,
  snapshot: WatchSnapshot,
  options: { compact?: boolean } = {}
): string {
  if (options.compact) {
    const relation = describeProcessRelation(processRecord, visibleProcessIds, knownProcessIds, options);
    return `${relation} ${processRecord.name} | ${processRecord.id} | ${describeCompactStatus(processRecord, snapshot)}`;
  }

  const indent = "  ".repeat(Math.max(0, processRecord.depth - 1));
  const relation = describeProcessRelation(processRecord, visibleProcessIds, knownProcessIds, options);
  const reviewNote = describeReviewRetention(processRecord, snapshot);
  return `${indent}${relation} ${processRecord.name} | ${processRecord.id} | ${processRecord.runtime} | ${processRecord.status}${reviewNote} | depth=${processRecord.depth}`;
}

function describeProcessRelation(
  processRecord: DuoProcess,
  visibleProcessIds: Set<string>,
  knownProcessIds: Set<string>,
  options: { compact?: boolean } = {}
): string {
  if (!processRecord.parentId) {
    return "root>";
  }
  if (visibleProcessIds.has(processRecord.parentId) || knownProcessIds.has(processRecord.parentId)) {
    const parentRef = options.compact ? compactProcessRef(processRecord.parentId) : processRecord.parentId;
    return `child(${parentRef})>`;
  }
  const parentRef = options.compact ? compactProcessRef(processRecord.parentId) : processRecord.parentId;
  return `orphan(${parentRef})>`;
}

function compactProcessRef(processId: string): string {
  const withoutPrefix = processId.startsWith("proc_") ? processId.slice(5) : processId;
  return withoutPrefix.length > 8 ? withoutPrefix.slice(0, 8) : withoutPrefix;
}

function describeCompactStatus(processRecord: DuoProcess, snapshot: WatchSnapshot): string {
  if (processRecord.status === "running" || processRecord.status === "blocked") {
    return processRecord.status;
  }
  const updatedAt = Date.parse(processRecord.updatedAt);
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(capturedAt)) {
    return processRecord.status;
  }
  const ageMs = Math.max(0, capturedAt - updatedAt);
  if (ageMs > resolveRecentWindowMs(snapshot)) {
    return processRecord.status;
  }
  return `${processRecord.status} ${Math.round(ageMs / 1000)}s`;
}

function byCreatedAt(left: DuoProcess, right: DuoProcess): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function describeReviewRetention(processRecord: DuoProcess, snapshot: WatchSnapshot): string {
  if (processRecord.status === "running" || processRecord.status === "blocked") {
    return "";
  }
  const updatedAt = Date.parse(processRecord.updatedAt);
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(capturedAt)) {
    return "";
  }
  const ageMs = Math.max(0, capturedAt - updatedAt);
  if (ageMs > resolveRecentWindowMs(snapshot)) {
    return "";
  }
  return ` [finished ${Math.round(ageMs / 1000)}s ago, kept for review]`;
}

function resolveRecentWindowMs(snapshot: WatchSnapshot): number {
  return snapshot.recentWindowMs ?? 2 * 60 * 1000;
}

function describeWatchScope(snapshot: WatchSnapshot): string {
  const reviewWindow = `${Math.round(resolveRecentWindowMs(snapshot) / 1000)}s`;
  if (snapshot.includeAll) {
    return `all duo processes + finished processes kept ${reviewWindow} for review`;
  }
  if (snapshot.includeRoots) {
    return `root and child agents + finished processes kept ${reviewWindow} for review`;
  }
  return `active child agents + finished children kept ${reviewWindow} for review`;
}
