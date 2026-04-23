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
}

export function readWatchSnapshot(
  projectRoot: string,
  options: { lines: number; includeAll?: boolean; recentWindowMs?: number }
): WatchSnapshot {
  const state = readState(projectRoot);
  const recentWindowMs = options.recentWindowMs ?? 2 * 60 * 1000;
  const now = Date.now();
  const selected = Object.values(state.processes)
    .filter((processRecord) => shouldShowInWatch(processRecord, {
      includeAll: options.includeAll,
      recentWindowMs,
      now
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((processRecord) => ({
      process: processRecord,
      output: peekProcessOutput(processRecord, options.lines)
    }));

  return {
    state,
    processes: selected,
    capturedAt: new Date().toISOString()
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
  const header = [
    "duo watch",
    `captured: ${snapshot.capturedAt}`,
    `brake: ${snapshot.state.brake?.active ? snapshot.state.brake.reason : "off"}`,
    `visible_processes: ${snapshot.processes.length}`
  ].join(" | ");

  if (snapshot.processes.length === 0) {
    return `${header}\n\nNo visible duo processes.\n`;
  }

  if (options.layout === "columns" && snapshot.processes.length >= 2) {
    return renderColumnsFrame(snapshot, header, options.terminalWidth);
  }

  const sections = snapshot.processes.map(({ process, output }) => {
    const body = output.trim() || "[no captured output yet]";
    return [
      "=".repeat(80),
      `${process.name} | ${process.id} | ${process.runtime} | ${process.status} | depth=${process.depth}`,
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
  options: { includeAll?: boolean; recentWindowMs: number; now: number }
): boolean {
  if (options.includeAll) {
    return true;
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

  const columns = selected.map(({ process, output }) => {
    const title = `${process.name} | ${process.runtime} | ${process.status}`;
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
    for (let index = 0; index < normalized.length; index += width) {
      output.push(normalized.slice(index, index + width).padEnd(width, " "));
    }
  }
  return output;
}
