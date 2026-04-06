import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentName, ItemType, ResolvedAction, SimTime, WorldState } from "./types.js";
import { getAgentNames, getDisplayName } from "./world-registry.js";

const DATA_DIR = join(process.cwd(), "data");

export function readAgentMemory(agent: AgentName): string {
  const path = join(DATA_DIR, "memory", `${agent}.md`);
  return readFileSync(path, "utf-8");
}

export function readAgentProfile(agent: AgentName): string {
  const path = join(DATA_DIR, "profiles", `${agent}.md`);
  return readFileSync(path, "utf-8");
}

export function readWorldState(): WorldState {
  const state = JSON.parse(readFileSync(join(DATA_DIR, "world_state.json"), "utf-8")) as WorldState;
  state.loans ??= [];
  state.caughtStealing ??= {};
  state.active_laws ??= [];
  state.banned ??= {};
  state.tax_rate ??= 0.10;
  state.pending_petitions ??= [];
  return state;
}

export function writeWorldState(state: WorldState): void {
  const path = join(DATA_DIR, "world_state.json");
  // Guard against clobbering meeting state injected mid-tick via God Mode.
  try {
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as Partial<WorldState>;
    // God Mode may have injected a more urgent meeting while the tick was running.
    // Per-village: merge each village's meeting — use whichever fires sooner.
    const diskMeetings = (onDisk as Record<string, unknown>).pending_meetings as Record<string, import("./types.js").PendingMeeting> | undefined
      ?? (onDisk as Record<string, unknown>).pending_meeting  // backwards compat with old single-meeting state
        ? { brunnfeld: (onDisk as Record<string, unknown>).pending_meeting as import("./types.js").PendingMeeting }
        : {};
    const currentTick = state.current_tick ?? 0;
    for (const [vid, diskMtg] of Object.entries(diskMeetings ?? {})) {
      if (!diskMtg || diskMtg.scheduledTick <= currentTick) continue;
      const memMtg = state.pending_meetings[vid];
      if (!memMtg || diskMtg.scheduledTick < memMtg.scheduledTick) {
        console.log(`  🏛 [Merge] Picking up disk meeting [${vid}] "${diskMtg.description}" (scheduledTick=${diskMtg.scheduledTick}) over mem "${memMtg?.description ?? "none"}"`);
        state.pending_meetings[vid] = diskMtg;
        // Restore agent locations — God Mode teleported everyone to Town Hall
        for (const key of Object.keys(onDisk.agent_locations ?? {})) {
          state.agent_locations[key as AgentName] = onDisk.agent_locations![key as AgentName]!;
        }
      }
    }
  } catch { /* first write or parse error — proceed as-is */ }
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function writeTickLog(tick: number, log: object): void {
  const logsDir = join(DATA_DIR, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const path = join(logsDir, `tick_${tick.toString().padStart(5, "0")}.json`);
  writeFileSync(path, JSON.stringify(log, null, 2));
}

// ─── Memory Parsing ──────────────────────────────────────────

interface MemorySections {
  header: string;
  people: string[];
  experiences: string[];
  important: string[];
}

function parseMemory(content: string): MemorySections {
  const sections: MemorySections = { header: "", people: [], experiences: [], important: [] };
  let current: "header" | "people" | "experiences" | "important" = "header";

  for (const line of content.split("\n")) {
    if (line.startsWith("# ")) { sections.header = line; continue; }
    if (line.startsWith("## People")) { current = "people"; continue; }
    if (line.startsWith("## Experiences")) { current = "experiences"; continue; }
    if (line.startsWith("## Important")) { current = "important"; continue; }

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (current === "people") sections.people.push(trimmed);
    else if (current === "experiences" && trimmed !== "*(Nothing yet)*") sections.experiences.push(trimmed);
    else if (current === "important" && trimmed !== "*(Nothing)*") sections.important.push(trimmed);
  }

  return sections;
}

function serializeMemory(s: MemorySections): string {
  let out = s.header + "\n\n";
  out += "## People\n";
  out += s.people.length > 0 ? s.people.join("\n") + "\n" : "*(Nobody yet)*\n";
  out += "\n## Experiences\n";
  out += s.experiences.length > 0 ? s.experiences.join("\n") + "\n" : "*(Nothing yet)*\n";
  out += "\n## Important\n";
  out += s.important.length > 0 ? s.important.join("\n") + "\n" : "*(Nothing)*\n";
  return out;
}

function compressExperiences(entries: string[]): string[] {
  if (entries.length <= 20) return entries;

  const recent = entries.slice(-20);
  const older = entries.slice(0, -20);
  const compressed: string[] = [];

  for (let i = 0; i < older.length; i += 10) {
    const batch = older.slice(i, i + 10);
    const names = new Set<string>();

    for (const entry of batch) {
      for (const a of getAgentNames()) {
        const dname = getDisplayName(a);
        if (entry.includes(dname)) names.add(dname);
      }
    }

    const timeMatch = batch[0]?.match(/^(\S+ \d+:\d+)/);
    const timeRef = timeMatch ? timeMatch[1] : "Earlier";
    let summary = `[${timeRef}]: `;
    if (names.size > 0) summary += `Interacted with ${[...names].join(", ")}. `;
    summary += "Routine.";
    compressed.push(summary);
  }

  return [...compressed.slice(-5), ...recent];
}

/**
 * Extracts a compact narrative from a harness historyLines trace.
 * Only interaction tool calls (speak, negotiate, produce, move_to, buy_item, post_order, eat)
 * are included — pure observation calls are skipped.
 * Returns an empty string if no meaningful actions were taken.
 */
function summarizeHarnessTrace(historyLines: string[]): string {
  const INTERACTION_RE = /^→ (speak|negotiate|produce|move_to|buy_item|post_order|eat)\(/;
  const meaningful: string[] = [];

  for (let i = 0; i < historyLines.length; i += 2) {
    const call = historyLines[i] ?? "";
    const result = historyLines[i + 1] ?? "";
    if (!INTERACTION_RE.test(call)) continue;
    const outcome = result.replace(/^← /, "").slice(0, 80);
    if (outcome) meaningful.push(outcome);
  }

  return meaningful.join(". ");
}

export function updateAgentMemoryFromActions(
  agent: AgentName,
  time: SimTime,
  location: string,
  otherAgents: string[],
  actions: ResolvedAction[],
  historyLines?: string[],
): void {
  const content = readAgentMemory(agent);
  const sections = parseMemory(content);

  const timeShort = `${time.dayOfWeek} ${time.hour.toString().padStart(2, "0")}:00`;
  const othersStr = otherAgents.length > 0
    ? `. ${otherAgents.join(", ")} ${otherAgents.length === 1 ? "was" : "were"} there`
    : "";
  const header = `${timeShort}. ${location}${othersStr}.`;

  // If harness historyLines are available, synthesize a richer experience entry
  if (historyLines && historyLines.length > 0) {
    const summary = summarizeHarnessTrace(historyLines);
    if (summary) {
      sections.experiences.push(`${header} ${summary}`);
    }
  } else {
    // Fallback: sparse action-based entry (non-harness path)
    const parts: string[] = [header];
    let hasContent = false;
    for (const action of actions) {
      switch (action.type) {
        case "speak":
          parts.push(`Said: "${action.text?.substring(0, 80)}"`);
          hasContent = true;
          break;
        case "think":
          if (action.text) {
            parts.push(action.text.substring(0, 60) + (action.text.length > 60 ? "..." : ""));
            hasContent = true;
          }
          break;
        case "move_to":
          parts.push(`Went to ${action.location}.`); hasContent = true;
          break;
        case "produce":
          if (action.result && !action.result.startsWith("[")) {
            parts.push(action.result); hasContent = true;
          }
          break;
        case "buy_item":
        case "post_order":
          if (action.result && !action.result.startsWith("[")) {
            parts.push(action.result); hasContent = true;
          }
          break;
        case "send_message":
          parts.push(`Sent message to ${action.to || action.target}.`); hasContent = true;
          break;
        case "knock_door":
          parts.push(`Knocked at ${action.target}'s door. ${action.result}`); hasContent = true;
          break;
      }
    }
    if (hasContent) {
      sections.experiences.push(parts.join(" "));
    }
  }

  // Pin significant trade events to Important
  const significantResults = actions.filter(a =>
    a.result && (
      a.result.includes("Sold") ||
      a.result.includes("Bought") ||
      a.result.includes("Barter completed") ||
      a.result.includes("starved")
    )
  );
  for (const action of significantResults) {
    if (sections.important.length < 5) {
      sections.important.push(`- ${time.timeLabel}: ${action.result!.substring(0, 100)}`);
    }
  }

  sections.experiences = compressExperiences(sections.experiences);

  writeFileSync(join(DATA_DIR, "memory", `${agent}.md`), serializeMemory(sections));
}

export function updateRelationships(
  agent: AgentName,
  actions: ResolvedAction[],
  otherAgents: string[],
): void {
  if (otherAgents.length === 0) return;

  const content = readAgentMemory(agent);
  const sections = parseMemory(content);

  for (const action of actions) {
    if (action.type !== "think" && action.type !== "speak") continue;
    const text = action.text || "";

    for (const other of otherAgents) {
      if (!text.includes(other)) continue;
      const existingIdx = sections.people.findIndex(e => e.startsWith(`- ${other}:`));
      if (existingIdx === -1) {
        const impression = text.length > 80 ? text.substring(0, 80) + "..." : text;
        sections.people.push(`- ${other}: ${impression}`);
      }
    }
  }

  writeFileSync(join(DATA_DIR, "memory", `${agent}.md`), serializeMemory(sections));
}

export function logsExist(): boolean {
  return existsSync(join(DATA_DIR, "logs", "tick_00001.json"));
}
