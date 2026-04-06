import type { AgentAction, AgentName, AgentTurnResult, ItemType, WorldState, SimTime } from "./types.js";
import { callClaudeJSON } from "./llm.js";
import { emitSSE } from "./events.js";
import { readAgentProfile, readAgentMemory } from "./memory.js";
import { getInventoryQty, getReserved } from "./inventory.js";
import { getRelevantOrders, getAgentMarketplace } from "./marketplace.js";
import { getToolPerception } from "./tools-degradation.js";
import { bodyPerception } from "./body.js";
import { buildActionSchema, resolveAction, type ResolveContext } from "./tools.js";
import { tickToTime } from "./time.js";
import { RECIPES, MULTI_FARM_ITEMS } from "./production.js";
import { computeVillageConcerns } from "./village-concerns.js";
import { getAgentNames, getDisplayName, getCouncilMembers, getAgentVillage, getVillageLocations, getLocationType, getVillages, getVillageElder, getVillageTownHall, getRoads, isRoadLocation, getVillageForLocation } from "./world-registry.js";

// ─── Hunger food hint ─────────────────────────────────────────

const EDIBLE_ITEMS = new Set<string>(["bread", "meal", "meat", "vegetables", "eggs", "milk"]);


function getHungryNoFoodHint(agent: AgentName, state: WorldState): string {
  const body = state.body[agent];
  if (body.hunger < 2) return "";

  const eco = state.economics[agent];
  const hasFood = eco.inventory.items.some(
    i => EDIBLE_ITEMS.has(i.type) && (i.quantity - (i.reserved ?? 0)) > 0
  );
  if (hasFood) return "";

  return "(You have no food in your inventory.)";
}

// ─── Location keeper note ─────────────────────────────────────

const SPECIALIST_SKILLS = new Set<string>(["miller", "baker", "tavern", "blacksmith", "carpenter", "healer", "seamstress"]);

function getLocationKeeperNote(agent: AgentName, state: WorldState): string {
  const location = state.agent_locations[agent];
  for (const a of getAgentNames()) {
    if (a === agent) continue;
    const aEco = state.economics[a];
    if (aEco.workLocation !== location) continue;
    if (!SPECIALIST_SKILLS.has(aEco.skill)) continue;
    // This is a specialist's work location
    if (state.agent_locations[a] !== location) {
      const keeperName = getDisplayName(a);
      const keeperLoc = state.agent_locations[a];
      return `(This is ${keeperName}'s ${location}. ${keeperName} is currently at ${keeperLoc}. Use send_message to ${keeperName} to arrange a purchase, or check the Village Square marketplace.)`;
    }
    return ""; // Keeper is present — already listed in "Others here"
  }
  return "";
}

// ─── Loan perception ──────────────────────────────────────────

function getLoanPerception(agent: AgentName, state: WorldState): string {
  if (!state.loans || state.loans.length === 0) return "";

  const activeLoans = state.loans.filter(l => !l.repaid);
  const owed = activeLoans.filter(l => l.creditor === agent);
  const owes = activeLoans.filter(l => l.debtor === agent);

  if (owed.length === 0 && owes.length === 0) return "";

  const parts: string[] = [];
  for (const loan of owed) {
    const dueDay = Math.ceil(loan.dueTick / 16);
    parts.push(`You are owed ${loan.amount}c by ${getDisplayName(loan.debtor)} (due day ${dueDay}).`);
  }
  for (const loan of owes) {
    const dueDay = Math.ceil(loan.dueTick / 16);
    parts.push(`You owe ${loan.amount}c to ${getDisplayName(loan.creditor)} (due day ${dueDay}).`);
  }

  return `\nLoans: ${parts.join(" ")}`;
}

// ─── Governance helpers ──────────────────────────────────

function getVillageLaws(state: WorldState, time: SimTime): string {
  if (!state.active_laws || state.active_laws.length === 0) return "";
  const lines = state.active_laws.map(law => {
    const day = Math.ceil(law.passedTick / 16);
    if (law.type === "tax_change") return `- Tax rate: ${Math.round((law.value ?? 0.1) * 100)}% (passed day ${day})`;
    if (law.type === "banishment" && law.target) {
      const untilTick = state.banned?.[law.target] ?? (law.passedTick + 32);
      const untilDay = Math.ceil(untilTick / 16);
      return `- ${getDisplayName(law.target ?? "")} banished until day ${untilDay}`;
    }
    return `- ${law.description} (passed day ${day})`;
  });
  return `\nVillage Laws:\n${lines.join("\n")}`;
}

function getMeetingContext(agent: AgentName, state: WorldState, time: SimTime): string {
  const vid = getAgentVillage(agent);
  const mtg = state.pending_meetings[vid];
  if (!mtg) return "";
  if (time.tick < mtg.scheduledTick) {
    const townHall = getVillageTownHall(vid);
    const meetingTime = tickToTime(mtg.scheduledTick);
    return `\n(Village meeting: "${mtg.description}" at ${townHall} on ${meetingTime.timeLabel}. Be there.)`;
  }
  return "";
}

// ─── Perception builder ──────────────────────────────────────

function buildInventoryLines(agent: AgentName, state: WorldState): string {
  const eco = state.economics[agent];
  const lines = eco.inventory.items
    .filter(i => i.quantity > 0)
    .map(i => {
      const reserved = i.reserved ?? 0;
      const reservedNote = reserved > 0 ? ` (${reserved} listed for sale — will transfer when bought)` : "";
      const spoilNote = i.spoilsAtTick && i.spoilsAtTick - state.current_tick < 32 ? " [spoils soon]" : "";
      return `${i.type} ×${i.quantity}${reservedNote}${spoilNote}`;
    });
  return lines.length > 0 ? lines.join(", ") : "empty";
}

function buildMarketboardLines(agent: AgentName, state: WorldState): string {
  const orders = getRelevantOrders(agent, state);
  if (orders.length === 0) return "  (no current orders)";
  return orders
    .map(o => o.type === "sell"
      ? `  SELL: ${o.item} ×${o.quantity} at ${o.price}c (by ${getDisplayName(o.agentId) || o.agentId}, expires in ${o.expiresAtTick - state.current_tick} ticks)`
      : `  WANT: ${o.item} ×${o.quantity}, paying up to ${o.price}c (${getDisplayName(o.agentId) || o.agentId})`
    )
    .join("\n");
}

function getProducibleBlock(agent: AgentName, state: WorldState): string {
  const eco = state.economics[agent];
  const location = state.agent_locations[agent];
  const lines: string[] = [];

  for (const [itemKey, recipe] of Object.entries(RECIPES)) {
    if (recipe.skill !== eco.skill) continue;
    const validLocations = MULTI_FARM_ITEMS[itemKey] ?? [recipe.location];
    if (!validLocations.includes(location)) continue;

    const outputStr = Object.entries(recipe.output).map(([k, v]) => `${v} ${k}`).join(", ");

    if (recipe.tool && (!eco.tool || eco.tool.durability <= 0)) {
      lines.push(`- produce "${itemKey}" → ${outputStr} [needs tools — yours are broken or missing]`);
      continue;
    }

    const missing: string[] = [];
    for (const [inputItem, qty] of Object.entries(recipe.inputs)) {
      const have = getInventoryQty(eco.inventory, inputItem as ItemType);
      if (have < qty) missing.push(`${inputItem} (need ${qty}, have ${have})`);
    }

    if (missing.length === 0) {
      lines.push(`- produce "${itemKey}" → ${outputStr} [ready now]`);
    } else {
      lines.push(`- produce "${itemKey}" → ${outputStr} [missing: ${missing.join(", ")}]`);
    }
  }

  if (lines.length === 0) return "";
  return `\nYou can produce here:\n${lines.join("\n")}`;
}

// ─── Travel hint block ────────────────────────────────────────

function buildTravelBlock(agent: AgentName, state: WorldState): string {
  const villages = getVillages();
  if (villages.length <= 1) return "";

  const loc = state.agent_locations[agent];
  const roads = getRoads();
  const onRoad = isRoadLocation(loc);

  if (onRoad) {
    const road = roads.find(r => r.name === loc);
    if (!road) return "";
    const lines = road.connectsVillages.map(vid => {
      const v = villages.find(v => v.id === vid);
      const vName = v?.name ?? vid;
      const vSquare = v?.locations.find(l => l.endsWith("Village Square")) ?? v?.locations[0] ?? vid;
      return `  Go to ${vName}: move_to "${vSquare}"`;
    });
    return `Travel options (pick a direction):\n${lines.join("\n")}`;
  }

  const currentVid = getVillageForLocation(loc) ?? getAgentVillage(agent);
  const reachableRoads = roads.filter(r => r.connectsVillages.includes(currentVid));
  if (reachableRoads.length === 0) return "";

  const lines = reachableRoads.map(road => {
    const destVid = road.connectsVillages.find(v => v !== currentVid) ?? "";
    const destName = villages.find(v => v.id === destVid)?.name ?? destVid;
    return `  Travel to ${destName}: move_to "${road.name}" (${road.transitTicks} tick travel, costs 1 hunger)`;
  });
  return `Travel:\n${lines.join("\n")}`;
}

// ─── Road perception (minimal — no marketplace, no production) ─

function buildRoadPerception(
  agent: AgentName,
  state: WorldState,
  time: SimTime,
  otherAgentsPresent: string[],
  pendingMessages: string,
  conversationSoFar: string,
): string {
  const eco = state.economics[agent];
  const body = state.body[agent];
  const location = state.agent_locations[agent];
  const feedback = (state.action_feedback[agent] ?? []).join("\n");
  const bodyNote = bodyPerception(body);
  const inventoryLines = buildInventoryLines(agent, state);

  const road = getRoads().find(r => r.name === location);
  const [v1id, v2id] = road?.connectsVillages ?? [];
  const v1Name = getVillages().find(v => v.id === v1id)?.name ?? v1id ?? "?";
  const v2Name = getVillages().find(v => v.id === v2id)?.name ?? v2id ?? "?";

  const othersStr = otherAgentsPresent.length > 0
    ? `Others on the road: ${otherAgentsPresent.join(", ")}.`
    : "You are alone on the road.";

  return `RULE: Speech NEVER moves goods or coin. Only post_order and buy_item create real transfers. Saying "here are 4 coins" does nothing.

You are ${getDisplayName(agent)}.
Location: ${location}. ${time.timeLabel}. ${time.season.charAt(0).toUpperCase() + time.season.slice(1)}, day ${time.seasonDay}/7.
Weather: ${state.weather}

You are travelling between ${v1Name} and ${v2Name}. You will arrive at your destination next tick.

${othersStr}
${bodyNote ? bodyNote + "\n" : ""}
Inventory: ${inventoryLines}
Wallet: ${eco.wallet} coin

${pendingMessages ? `Messages:\n${pendingMessages}\n` : ""}${feedback ? `Last tick feedback:\n${feedback}\n` : ""}${conversationSoFar ? `\nConversation so far:\n${conversationSoFar}\n` : ""}`.trim();
}

// ─── Full perception ──────────────────────────────────────────

export function buildPerception(
  agent: AgentName,
  state: WorldState,
  time: SimTime,
  conversationSoFar: string,
  otherAgentsPresent: string[],
  pendingMessages: string,
  sounds: string[],
): string {
  const eco = state.economics[agent];
  const body = state.body[agent];
  const location = state.agent_locations[agent];

  // Road agents get a stripped-down perception with no marketplace/production context
  if (isRoadLocation(location)) {
    return buildRoadPerception(agent, state, time, otherAgentsPresent, pendingMessages, conversationSoFar);
  }

  const bodyNote = bodyPerception(body);
  const hungryHint = getHungryNoFoodHint(agent, state);
  const keeperNote = getLocationKeeperNote(agent, state);
  const loanPerception = getLoanPerception(agent, state);
  const inventoryLines = buildInventoryLines(agent, state);
  const toolLine = getToolPerception(agent, state);
  const producibleBlock = getProducibleBlock(agent, state);
  const marketboardLines = buildMarketboardLines(agent, state);

  const agentOrders = getAgentMarketplace(agent, state).orders.filter(o => o.agentId === agent);
  const activeOrdersBlock = agentOrders.length > 0
    ? `\nYour active orders:\n${agentOrders.map(o =>
        `${o.type.toUpperCase()} ${o.item} x${o.quantity} at ${o.price}c each (id: ${o.id}, expires in ${o.expiresAtTick - time.tick} ticks)`
      ).join("\n")}`
    : "";

  const othersStr = otherAgentsPresent.length > 0
    ? `Others here: ${otherAgentsPresent.join(", ")}.`
    : "You are alone here.";

  const soundsStr = sounds.length > 0
    ? `Sounds: ${sounds.join(" ")}`
    : "";

  const hiredNote = eco.hiredBy
    ? `\nYou are hired by ${getDisplayName(eco.hiredBy)} today.`
    : "";

  const laborerNote = (() => {
    for (const a of getAgentNames()) {
      if (state.economics[a].hiredBy === agent) {
        return `\n${getDisplayName(a)} is working for you today.`;
      }
    }
    return "";
  })();

  const feedback = (state.action_feedback[agent] ?? []).join("\n");

  const activeEvents = state.active_events.length > 0
    ? `\nVillage events: ${state.active_events.map(e => e.description).join("; ")}`
    : "";
  const lawsBlock = getVillageLaws(state, time);
  const meetingCtx = getMeetingContext(agent, state, time);

  const villageConcernsBlock = agent === getVillageElder(getAgentVillage(agent))
    ? (() => {
        const concerns = computeVillageConcerns(state, time.tick);
        return concerns.length > 0 ? "\n" + concerns.join("\n") : "";
      })()
    : "";

  return `RULE: Speech NEVER moves goods or coin. Only post_order and buy_item create real transfers. Saying "here are 4 coins" does nothing.

You are ${getDisplayName(agent)}.
Location: ${location}. ${time.timeLabel}. ${time.season.charAt(0).toUpperCase() + time.season.slice(1)}, day ${time.seasonDay}/7.
Weather: ${state.weather}${activeEvents}${lawsBlock}${meetingCtx}${villageConcernsBlock}

${othersStr}${soundsStr ? "\n" + soundsStr : ""}${keeperNote ? "\n" + keeperNote : ""}
${bodyNote ? bodyNote + "\n" : ""}${hungryHint ? hungryHint + "\n" : ""}
Inventory: ${inventoryLines}
Wallet: ${eco.wallet} coin${loanPerception}
Tools: ${toolLine}${hiredNote}${laborerNote}${producibleBlock}${activeOrdersBlock}

Marketplace board:
${marketboardLines}

${pendingMessages ? `Messages:\n${pendingMessages}\n` : ""}${feedback ? `Last tick feedback:\n${feedback}\n` : ""}${conversationSoFar ? `\nConversation so far:\n${conversationSoFar}\n` : ""}`.trim();
}

export function buildMeetingPerception(
  agent: AgentName,
  state: WorldState,
  time: SimTime,
  conversationSoFar: string,
  othersPresent: string[],
  meetingPhase: "discussion" | "vote",
  proposal?: string,
): string {
  const vid = getAgentVillage(agent);
  const mtg = state.pending_meetings[vid]!;
  const eco = state.economics[agent];
  const body = state.body[agent];
  const feedback = (state.action_feedback[agent] ?? []).join("\n");
  const lawsBlock = getVillageLaws(state, time);

  const othersStr = othersPresent.length > 0
    ? `Present: ${othersPresent.join(", ")}.`
    : "You are alone here.";

  const councilNote = getCouncilMembers(vid).includes(agent)
    ? `\nYou hold a council seat. This meeting is part of your duties as a council member.`
    : "";

  const phaseNote = meetingPhase === "discussion"
    ? `\n=== VILLAGE MEETING — DISCUSSION ===\nAgenda: "${mtg.description}" (${mtg.agendaType.replace("_", " ")})\nSpeak your mind. If you have a concrete proposal, use propose_rule with a specific text (and value if it's numeric, e.g. tax rate 0.15). You can also just speak or think.`
    : `\n=== VILLAGE MEETING — VOTE ===\nProposal on the table: "${proposal ?? "(no specific rule proposed)"}"\nUse the vote action with side "agree" or "disagree". Speak first if you want.`;

  return `You are ${getDisplayName(agent)}.
Location: Town Hall. ${time.timeLabel}. ${time.season.charAt(0).toUpperCase() + time.season.slice(1)}, day ${time.seasonDay}/7.
Weather: ${state.weather}${lawsBlock}

${othersStr}${councilNote}
${body.hunger > 1 ? `Hunger: ${body.hunger}/5.` : ""}
Wallet: ${eco.wallet} coin
${feedback ? `Last tick feedback:\n${feedback}\n` : ""}${conversationSoFar ? `\nConversation so far:\n${conversationSoFar}\n` : ""}${phaseNote}`.trim();
}

// ─── Prompt builder ───────────────────────────────────────────

function buildPrompt(agent: AgentName, perception: string, actionSchema: string, state: WorldState): string {
  const name = getDisplayName(agent);
  const profile = readAgentProfile(agent);
  const memory = readAgentMemory(agent);

  // Use current physical village, not home village
  const currentLoc = state.agent_locations[agent];
  const onRoad = isRoadLocation(currentLoc);
  const currentVillageId = onRoad
    ? getAgentVillage(agent)
    : (getVillageForLocation(currentLoc) ?? getAgentVillage(agent));

  const villageName = getVillages().find(v => v.id === currentVillageId)?.name ?? "";
  const displayLocs = onRoad ? [] : getVillageLocations(currentVillageId).map(loc =>
    villageName && loc.startsWith(`${villageName}:`) ? loc.slice(villageName.length + 1) : loc
  );
  const locationsLine = displayLocs.length > 0 ? `Locations in the village: ${displayLocs.join(", ")}` : "";

  const travelBlock = buildTravelBlock(agent, state);

  return `You are ${name}.

${profile}
${locationsLine ? "\n" + locationsLine : ""}
${memory}

---

${perception}
${travelBlock ? "\n" + travelBlock + "\n" : ""}
${actionSchema}`;
}

// ─── Run single agent turn ────────────────────────────────────

export async function runAgentTurn(
  agent: AgentName,
  perception: string,
  context: ResolveContext,
): Promise<AgentTurnResult> {
  const model = process.env.CHARACTER_MODEL || "haiku";
  const hasConcerns = computeVillageConcerns(context.state, context.time.tick).length > 0;
  const agentVid = getAgentVillage(agent);
  const atMeeting = context.agentLocation === getVillageTownHall(agentVid) && !!context.state.pending_meetings[agentVid];
  const prompt = buildPrompt(agent, perception, buildActionSchema(agent, hasConcerns, atMeeting), context.state);
  const name = getDisplayName(agent);

  // Emit "agent is thinking" to frontend
  emitSSE("agent:thinking", { agent, name });

  let response: { actions: AgentAction[] };
  try {
    response = await callClaudeJSON<{ actions: AgentAction[] }>(prompt, {
      model,
      onChunk: (chunk) => {
        emitSSE("agent:stream", { agent, name, chunk });
      },
    });
  } catch (err) {
    emitSSE("agent:stream", { agent, name, chunk: "" });
    console.error(`  LLM error for ${agent}: ${err}. Defaulting to wait.`);
    return { agent, actions: [{ type: "wait", result: "", visible: false }], pendingMove: undefined };
  }
  emitSSE("agent:stream", { agent, name, chunk: "" });  // signal stream done

  const KNOWN_ACTION_TYPES = new Set([
    "speak", "think", "wait", "move_to", "produce", "buy_item", "post_order",
    "cancel_order", "give_item", "hire", "loan_request", "loan_repay",
    "steal", "vote", "call_meeting", "petition_meeting", "dismiss", "craft",
    "eat",
  ]);
  const actions = (response.actions || []).map(action => {
    let sanitized = action;
    if (!action.type) {
      sanitized = { ...action, type: "think" as const };
    } else if (!KNOWN_ACTION_TYPES.has(action.type)) {
      sanitized = { type: "think" as const, text: action.text ?? String(action.type) };
    }
    return resolveAction(sanitized, context);
  });
  if (actions.length === 0) actions.push(resolveAction({ type: "wait" }, context));

  // One-line terminal summary per agent (collected after resolution, no interleaving)
  const summary = actions
    .filter(a => a.type !== "think" && a.type !== "wait")
    .map(a => a.type === "move_to" ? `→${a.location}` : a.type)
    .join(", ") || "wait";
  console.log(`  ✦ ${name}: ${summary}`);

  // Emit move actions immediately so the map animates in real-time
  for (const action of actions) {
    if (action.type === "move_to" && action.visible && action.result) {
      emitSSE("agent:action", { agent, name, actionType: action.type, text: action.text, result: action.result, location: action.location });
    }
  }

  const pendingMove = actions.find(a => a.type === "move_to" && a.visible)?.location;
  return { agent, actions, pendingMove };
}

// ─── Batched parallel execution ────────────────────────────────

export async function runBatchedAgents(
  agents: AgentName[],
  perceptions: Record<AgentName, string>,
  state: WorldState,
  time: SimTime,
  batchSize = 5,
  movedThisTick?: Set<AgentName>,
): Promise<AgentTurnResult[]> {
  const results: AgentTurnResult[] = [];

  for (let i = 0; i < agents.length; i += batchSize) {
    const batch = agents.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(agent => {
        const context: ResolveContext = {
          agent,
          agentLocation: state.agent_locations[agent],
          state,
          time,
          movedThisTick,
        };
        return runAgentTurn(agent, perceptions[agent]!, context);
      })
    );
    results.push(...batchResults);
  }

  return results;
}
