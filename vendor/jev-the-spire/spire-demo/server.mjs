import {facingState} from './facing.mjs';
import {selectionState} from './selections.mjs';
import {encounterBrief,encounterMemory} from './encounters.mjs';
import http from 'node:http';
import { unlinkSync } from 'node:fs';
import {rewardState,unclaimedGold} from './rewards.mjs';
import {efficientDeliberate,EFFICIENT_POLICY} from '../../../integration/sts2/efficient-decisions.mjs';
import {hierarchicalDeliberate,newStrategyStatus} from '../../../integration/sts2/hierarchical.mjs';
import {filePlaybook} from '../../../integration/sts2/playbook.mjs';
import {makeGlossary,bridgeLookup} from '../../../integration/sts2/glossary.mjs';
import {loadMovesets,recordIntents} from '../../../integration/sts2/movesets.mjs';
import {loadFightResults,recordFight} from '../../../integration/sts2/fight-results.mjs';
import {fileMechanics} from '../../../integration/sts2/mechanics.mjs';
import {loadCardStats} from '../../../integration/sts2/card-stats.mjs';
import {replayer} from '../../../integration/sts2/replay.mjs';
import {addToHistory,loadHistory} from '../../../integration/sts2/strategy-history.mjs';
import {fileChannel} from '../../../integration/sts2/strategy-channel.mjs';
import {STRATEGY_POLICY} from '../../../integration/sts2/strategy.mjs';
import {FACTS_POLICY,FACTS_V3_POLICY,rememberMap,travelledTo} from '../../../integration/sts2/route-facts.mjs';
import {planBenefitDeliberate,persistentPlan} from './plan-benefit.mjs';
const planBenefitEnabled=process.env.SPIRE_PLAN_BENEFIT==='1';
import {assistedDeliberate} from './experiment/assisted.mjs';
const lunaEnabled=process.env.SPIRE_ADVISER==='luna';
if(lunaEnabled&&planBenefitEnabled)throw Error('Choose one experiment at a time: Luna or plan-benefit.');
import { readFile, mkdir, appendFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { readActiveCheckpoint, attachCheckpoint, defaultSaveRoot } from '../../../integration/sts2/save-state.mjs';
import { characterName } from '../../../integration/sts2/character.mjs';
import { labGit, fileSha256, fetchBridgeVersion, enabledMods, runStartRecord } from '../../../integration/sts2/run-record.mjs';
import { pinMismatch } from '../../../integration/sts2/pins.mjs';
import { repeatableDialogue } from '../../../integration/sts2/dialogue.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { actionsFor, fingerprint, factsFor, counterWait, triggeredCounters } from './actions.mjs';
import { pauseRecord, timeoutMessage, operatorCancel, writeDispatchMarker, PRE_ENQUEUE_REJECTION } from './runner-records.mjs';
import { simShadow } from '../../../integration/sts2/sim-shadow.mjs';
import { decisionCandidates, decisionQuestion, markHitsThisTurn, markLampUsed, noteDebuffCard, POLICY_VERSION } from './planner.mjs';
const turnHits = {}, lampMemory = {};

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4317);
const bridge = 'http://127.0.0.1:15526';
const logDir = process.env.SPIRE_LOG_DIR ?? resolve(root, '../.private/spire-runs');
await mkdir(logDir, { recursive: true, mode: 0o700 });
const lockFile = resolve(logDir, 'operator.lock');
const lock = await open(lockFile, 'wx').catch(() => { throw Error('An STS2 operator lock exists. Check the running dashboard before starting another.'); });
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
await lock.close();
process.once('exit', () => { try { unlinkSync(lockFile); } catch {} });
let apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  const config = await readFile(resolve(root, '../.private/typesafe.cfg'), 'utf8').catch(() => '');
  apiKey = config.match(/^api_key\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
}
const snapshotFile = resolve(logDir, 'session.json');
const saved = JSON.parse(await readFile(snapshotFile, 'utf8').catch(() => 'null'));
const sessionId = saved?.sessionId ?? new Date().toISOString().replaceAll(':', '-');
const logFile = resolve(logDir, `${sessionId}.jsonl`);
// Pinned so a new provider default can't change the model mid-comparison.
const JEV_MODEL = process.env.JEV_MODEL ?? 'jev-1.13.0';
// The lab commit at runner start, recorded in each run_start record (null without git).
const labGitInfo = labGit(resolve(root, '../../..'));
const MAX_DECISIONS = Number(process.env.MAX_DECISIONS ?? 2000);
const MAX_INPUT_TOKENS = Number(process.env.MAX_INPUT_TOKENS ?? 30000000);
if (!Number.isSafeInteger(MAX_DECISIONS) || MAX_DECISIONS < 1
    || !Number.isSafeInteger(MAX_INPUT_TOKENS) || MAX_INPUT_TOKENS < 1)
  throw Error('Session limits must be positive integers');
const view = {
  mode: 'paused', connected: false, configured: Boolean(apiKey), state: null,
  decisions: 0, actions: 0, inputTokens: 0, latencyMs: 0, model: null,
  message: 'Ready. Start a normal singleplayer run in the game, then press Autoplay.',
  events: [], sessionId, maxDecisions: MAX_DECISIONS, maxInputTokens: MAX_INPUT_TOKENS,
};
if (saved) Object.assign(view, saved, { mode: 'paused', pending: null, connected: false, configured: Boolean(apiKey), maxDecisions: MAX_DECISIONS, maxInputTokens: MAX_INPUT_TOKENS, message: 'Session restored. Press Autoplay to resume.' });
view.forcedActions ??= 0;
// Claude (the operator's Claude Code session) answers strategy requests through files.
// Decision modes: jev (jev-compact-v1 baseline, default), jev_facts (jev-compact-v2:
// exact route/resource facts), jev_facts_v3 (jev-compact-v3: order-aware route facts)
// and claude (v3 facts + Claude strategy).
const strategyAvailable=process.env.CLAUDE_STRATEGIST!=='off'&&!lunaEnabled&&!planBenefitEnabled;
const strategyDir=process.env.STRATEGY_DIR??resolve(logDir,'../strategy');
// Replay mode: .private/sts2/replay.json {source_run, target_run} (written by start-run --replay-from).
const replaySource=replayer({configPath:resolve(logDir,'../replay.json'),runsDir:logDir});
const strategist=strategyAvailable?{channel:fileChannel(strategyDir),playbook:filePlaybook(strategyDir),mechanics:fileMechanics(strategyDir),glossary:makeGlossary(bridgeLookup(bridge),{notes:fileMechanics(strategyDir)}),movesets:{},
  status:{...newStrategyStatus({enabled:view.strategy?.enabled??false,mode:process.env.CLAUDE_PLAN_MODE??'constrained',
    threshold:Number(process.env.CLAUDE_ESCALATE_BELOW??0.35),waitMs:1000*Number(process.env.CLAUDE_WAIT_SECONDS??300)}),
   plan:view.strategy?.plan??null,requests:view.strategy?.requests??0,answers:view.strategy?.answers??0,timeouts:view.strategy?.timeouts??0,
   // A mid-fight plan survives a restart during its fight; its fight_id keeps it out of any other fight.
   fightPlan:view.strategy?.fightPlan??null}}:null;
view.strategy=strategist?.status??null;
// Claude's recent strategy answers for the dashboard, rebuilt from the run log at startup.
view.strategyHistory=Array.isArray(view.strategyHistory)?view.strategyHistory:[];
loadHistory(logFile).then(h=>{if(h.length)view.strategyHistory=h;});
// Enemy move sequences seen in logged fights, shown to the strategist as patterns.
if(strategist)loadMovesets(logFile).then(m=>{for(const [k,v] of Object.entries(m))strategist.movesets[k]??=v;});
// How earlier card picks worked out, shown on card reward and shop options.
if(strategist)loadCardStats(logFile).then(c=>{strategist.cardStats=c;});
// How each encounter went, shown with its saved plan and used to re-review plans that did badly.
if(strategist)loadFightResults(logFile).then(r=>{strategist.fightResults=r;});
const DECISION_MODES=['jev','jev_facts','jev_facts_v3','claude'];
view.decisionMode=DECISION_MODES.includes(view.decisionMode)?view.decisionMode:view.strategy?.enabled?'claude':'jev';
if(view.decisionMode==='claude'&&!strategist)view.decisionMode='jev_facts';
if(strategist)strategist.status.enabled=view.decisionMode==='claude';
// The act map is only in map-screen observations; remember it and the node travelled to.
let mapMemory=null;
// The run whose stale strategy requests were last archived (observe).
let archivedFor=null;
view.planBenefitEnabled=planBenefitEnabled;
view.adviser=lunaEnabled?'gpt-5.6-luna:max':null;
// Fixed waits for bridges without a readiness report; a reported "ready" replaces them.
const SETTLE_MS = Number(process.env.SPIRE_SETTLE_MS ?? 700), COOLDOWN_MS = Number(process.env.SPIRE_COOLDOWN_MS ?? 1200);
const READY_SETTLE_MS = Number(process.env.SPIRE_READY_SETTLE_MS ?? 60), READY_SCREEN_SETTLE_MS = Number(process.env.SPIRE_READY_SCREEN_SETTLE_MS ?? 250);
// A relic counter at its trigger value (Happy Flower 3) usually resets to 0 about 0.5 s later, after
// the bridge already reports ready. Wait up to this long for it, once per relic trigger.
const COUNTER_SETTLE_MS = Number(process.env.SPIRE_COUNTER_SETTLE_MS ?? 1000);
let counterMemo = null;
const TICK_MS = Number(process.env.SPIRE_TICK_MS ?? 150);
const combatTypes = new Set(['monster','elite','boss']);
let generation = 0, busy = false, lastExecuted = '', latestState = null, waitingSince = 0, nextDecisionAt = 0;
let checkpoint = null, checkpointCheckedAt = 0, runCharacter = null;
async function log(event) {
  const entry = { time: new Date().toISOString(), ...event };
  view.events.unshift(entry); view.events.length = Math.min(view.events.length, 60);
  await appendFile(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
  // The dispatch marker (uncertainAction) must be on disk before a command is sent, so a crash
  // or stop can be reconciled on restart; other snapshots are throttled.
  if (entry.kind === 'dispatch') await flushSnapshot(); else persistSnapshot();
}
// Shadow-mode engine forecasts (SIM_FORECAST=shadow): logged beside decisions, never awaited.
const shadow = simShadow({ bridge, log });
// The dashboard snapshot (about 2 MB) is written at most every 2 s; the run log above is the record.
// Writes are serialized through one chain so a flush and a throttled write never race on the .tmp file.
let snapshotChain = Promise.resolve(), snapshotTimer = null;
// The returned promise rejects on failure (a failed dispatch-marker write must stop the step
// before the command is sent); the chain itself continues for later writes.
function writeSnapshot() {
  const write = snapshotChain.then(async () => {
    await writeFile(snapshotFile + '.tmp', JSON.stringify(view), { mode: 0o600 });
    // Windows reports EPERM/EACCES/EBUSY while another process (scanner, indexer, reader) briefly
    // holds session.json; JEV15 paused at the Act 2 boss on one. Retry before failing the step.
    for (let attempt = 0; ; attempt++) {
      try { await rename(snapshotFile + '.tmp', snapshotFile); break; }
      catch (error) {
        if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(r => setTimeout(r, Math.min(500, 50 * 2 ** attempt)));
      }
    }
  });
  snapshotChain = write.catch(error => console.error('Snapshot write failed:', error.message));
  return write;
}
function persistSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => { snapshotTimer = null; writeSnapshot().catch(() => {}); }, 2000);
}
async function flushSnapshot() {
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  await writeSnapshot();
}
async function gameRequest(path = '/api/v1/singleplayer', command) {
  let response, data;
  try {
    response = await fetch(bridge + path, {
      method: command ? 'POST' : 'GET',
      headers: command ? { 'Content-Type': 'application/json' } : {},
      body: command ? JSON.stringify(command) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    data = await response.json();
  } catch (error) { throw timeoutMessage(error, command ? 'Game command timed out' : 'Game state read timed out'); }
  if (!response.ok || data.error || data.status === 'error') throw new Error(data.error ?? data.message ?? `Game HTTP ${response.status}`);
  return data;
}
// Every pause is logged with its reason; reason null skips the record where another record already
// says why (an error, a run end, a reconciliation, a single step).
function stop(message, reason = 'unspecified', extra = {}) {
  generation++; view.mode = 'paused'; view.message = message;
  return reason === null ? Promise.resolve() : log(pauseRecord(reason, message, extra)).catch(error => console.error('Pause record failed:', error.message));
}
function sidecarView(source = view) {
  const decisions = source.events.filter(e => e.kind === 'decision' && ['executed', 'preview'].includes(e.outcome));
  const compact = e => {
    const candidates = e.candidates ?? actionsFor(e.state);
    return {
      decisionSource:e.decisionSource??'jev', memory:e.memory??null, encounter:encounterBrief(e.state), deliberation:e.deliberation ?? null, time: e.time, label: e.chosen.plan?.[0]?.label ?? e.chosen.label, plan: e.chosen.plan ?? null, forecast: e.chosen.forecast ?? null, policy: e.policy ?? "jev-actions-v1", description: e.chosen.details?.description ?? e.chosen.details?.card_description ?? '',
      action: e.chosen.command.action, confidence: e.answer.confidence, latencyMs: e.latencyMs,
      outcome: e.outcome, floor: e.state.run?.floor, facts: factsFor(e.state),
      options: (['forced','filtered','single_option'].includes(e.decisionSource)?candidates.map(c=>[c.id,null]):Object.entries(e.answer.probabilities ?? {})).map(([id, probability]) => ({
        id, probability, label: candidates.find(a => a.id === id)?.label ?? id, plan: candidates.find(a => a.id === id)?.plan ?? null, forecast: candidates.find(a => a.id === id)?.forecast ?? null, chosen: id === e.answer.choice,
      })).sort((a,b) => b.probability - a.probability),
    };
  };
  const compactDecisions = decisions.map(compact);
  return { adviser:source.adviser, review: source.review ?? null, policy: POLICY_VERSION, mode: source.mode, message: source.message, connected: source.connected, pending: source.pending ?? null, uncertainAction: source.uncertainAction ?? null,
    model: source.model, actions: source.actions, inputTokens: source.inputTokens, run: source.state?.run,
    player: source.state?.player ? { hp: source.state.player.hp, maxHp: source.state.player.max_hp, energy: source.state.player.energy, block: source.state.player.block } : null,
    room: source.state?.state_type, decisions: compactDecisions.slice(0, 8), spotlight: compactDecisions.find(e => e.options.length > 1) ?? compactDecisions[0] ?? null };
}
async function observe(retries = 2) {
  // State reads are read-only; a failed read (a transition-time exception or timeout) is retried
  // twice before the step fails and pauses.
  let live;
  for (let attempt = 0; ; attempt++) {
    try { live = await gameRequest(); break; }
    catch (error) { if (attempt >= retries) throw error; await new Promise(r => setTimeout(r, 1500)); }
  }
  const id = live.run?.live_id;
  if (id && view.runId && id !== view.runId) {
    stop('A different run was loaded. Check the game and press Autoplay to begin.', 'run_changed');
    view.events = []; lastExecuted = ''; checkpoint = null;
  }
  if (id) view.runId = id;
  // A strategy request left for another run (an earlier runner session, an abandoned run) is archived on
  // the first observation and whenever the run changes, so the next strategist does not answer it.
  if (id && strategist && id !== archivedFor) {
    archivedFor = id;
    const archived = await strategist.channel.archiveOtherRun(id).catch(() => null);
    if (archived) await log({ kind: 'strategy_archived', request_id: archived.id, reason: archived.stamp?.reason ?? null, run_id: archived.stamp?.run_id ?? null, current_run: id, file: archived.archivedAs });
  }
  const mismatch = checkpoint?.checkpoint?.run_id !== id
    || checkpoint?.checkpoint?.current_act_index + 1 !== live.run?.act;
  if (live.run && (mismatch || Date.now() - checkpointCheckedAt > 5000)) {
    checkpointCheckedAt = Date.now();
    try {
      const compendium = await gameRequest('/api/v1/compendium');
      checkpoint = await readActiveCheckpoint(compendium.current_run, defaultSaveRoot());
      view.save = { ...checkpoint, data: undefined };
    } catch (error) {
      checkpoint = null;
      view.save = { available: false, reason: error.message };
    }
  } else if (!live.run) { checkpoint = null; checkpointCheckedAt = 0; view.save = { available: false, reason: 'No active run' }; }
  // The bridge sends the displayed character title, which a skin mod can replace. Name the
  // character from the save's ID instead, kept for the run so the name (part of the state
  // fingerprint) doesn't change when the save is briefly unreadable.
  if (live.player && id) {
    const players = checkpoint?.available && checkpoint.checkpoint?.run_id === id ? checkpoint.data?.players : null;
    if (players?.length === 1 && characterName(players[0].character_id)) runCharacter = { run: id, name: characterName(players[0].character_id) };
    if (runCharacter?.run === id) live.player.character = runCharacter.name;
  }
  let joined = live;
  try { joined = attachCheckpoint(live, checkpoint); }
  catch(error) {
    checkpoint = null;
    view.save = {available:false,reason:error.message};
  }
  const s = selectionState(joined,view.events);
  // A stale map shown during travel does not move the remembered node back (rememberMap).
  mapMemory = rememberMap(mapMemory, s);
  latestState = s; view.state = s; view.connected = true;
  return s;
}
let lastEventId = null;
// The policy label for the current decision mode, logged on run_start and every decision.
const currentPolicy = () => planBenefitEnabled||lunaEnabled?POLICY_VERSION:view.decisionMode==='claude'?STRATEGY_POLICY:view.decisionMode==='jev_facts'?FACTS_POLICY:view.decisionMode==='jev_facts_v3'?FACTS_V3_POLICY:EFFICIENT_POLICY;
async function step(token, preview = false) {
  if (busy || Date.now() < nextDecisionAt) return;
  busy = true;
  try {
    // Observation latency, logged per decision: a slowing game shows here before play stalls.
    const observedAt = Date.now();
    const s = await observe();
    view.observeMs = Date.now() - observedAt;
    if (s.state_type !== 'game_over') lastEventId = s.state_type === 'event' ? s.event?.event_id ?? null : null;
    if (token !== generation) return;
    if (view.uncertainAction) throw Error('A previous action has an uncertain result. Inspect the game and acknowledge it before resuming.');
    if (s.state_type === 'game_over') {
      if(strategist?.fightResults)recordFight(strategist.fightResults,s);
      // The Architect event follows the final boss; the run then ends at 0 HP although it was won.
      const result = lastEventId === 'THE_ARCHITECT' ? 'victory' : s.player?.hp <= 0 ? 'defeat' : 'unknown';
      stop(result === 'unknown' ? 'Run ended. Verify the result in the game.' : `Run ended in ${result}.`, null);
      await log({ kind: 'run_end', result, state: s }); return;
    }
    if (s.hextech?.available === false) throw Error('Hextech active rules could not be read: '+s.hextech.error);
    if (s.run && !s.saved_run) {
      waitingSince ||= Date.now();
      view.message = 'Waiting for the saved checkpoint to match the live run: ' + (view.save?.reason ?? 'unavailable');
      if (Date.now() - waitingSince > 45000) await stop(view.message, 'checkpoint_mismatch');
      return;
    }
    // Once per run, before its first decision: what the run is played under (integration/sts2/run-record.mjs).
    if (s.run?.live_id && view.runStartFor !== s.run.live_id) {
      view.runStartFor = s.run.live_id;
      // Two retries, so one slow greeting can't fail the pinned build check below.
      let bridgeInfo = null;
      for (let i = 0; i < 3 && !bridgeInfo; i++) bridgeInfo = await fetchBridgeVersion(bridge + '/');
      await log(runStartRecord({state: s, git: labGitInfo, policy: currentPolicy(), decisionMode: view.decisionMode, model: JEV_MODEL,
        bridge: bridgeInfo,
        content: {playbook: await fileSha256(resolve(strategyDir, 'playbook.json')), mechanics: await fileSha256(resolve(strategyDir, 'mechanics.json'))},
        caps: {maxDecisions: MAX_DECISIONS, maxInputTokens: MAX_INPUT_TOKENS}, mods: await enabledMods(),
        save: checkpoint?.checkpoint?.run_id === s.run.live_id ? checkpoint.data : null}));
      if (token !== generation) return;
      // A run on another bridge build or game version pauses before its first decision (integration/sts2/pins.mjs);
      // resuming repeats the check and the run_start record.
      const pin = pinMismatch(bridgeInfo);
      if (pin) { view.runStartFor = null; await stop(pin, 'pin_mismatch'); return; }
    }
    // The bridge briefly reports unknown while entering a room or opening a selection.
    // Poll without issuing mutations, but retain a bounded stop for genuinely stuck screens.
    if (s.state_type === 'unknown') {
      waitingSince ||= Date.now();
      if (Date.now() - waitingSince > 45000) await stop('Unknown screen persisted for 45 seconds. Check the game, then resume.', 'unknown_screen');
      else view.message = 'Waiting for the room transition to finish…';
      return;
    }
    if (['menu', 'overlay'].includes(s.state_type)) {
      await stop(`Waiting at ${s.state_type}. Resolve this screen in the game, then resume.`, s.state_type); return;
    }
    if(strategist){recordIntents(strategist.movesets,s);if(strategist.fightResults)recordFight(strategist.fightResults,s);}
    const planningState=markLampUsed(lampMemory,markHitsThisTurn(turnHits,facingState(s,view.events)));
    // Claude mode owns full-belt potion rewards, so it gets discard-to-swap candidates there.
    const actions = decisionCandidates(rewardState(planningState,view.events),{potionSwaps:view.decisionMode==='claude'});
    if (!actions.length) {
      waitingSince ||= Date.now();
      if (Date.now() - waitingSince > 45000) await stop('No playable actions for 45 seconds. Check the game screen, then resume.', 'no_actions');
      else view.message = 'Waiting for the next playable state…';
      return;
    }
    const hash = fingerprint(s);
    if (hash === lastExecuted && !repeatableDialogue(s, actions, view.events)) {
      waitingSince ||= Date.now();
      if (Date.now() - waitingSince > 45000) await stop('The game did not change after the last action. Check the screen before resuming.', 'no_change');
      else view.message = 'Waiting for the game to finish the last action…';
      return;
    }
    // The bridge reports when queued game actions are still resolving.
    // Only ordinary combat play waits on the queue. A selection screen (hand_select, card_select…)
    // is itself what the queued action is waiting for, so it must be answered, not waited on.
    const busyNow = st => st.ready === false && combatTypes.has(st.state_type);
    if (busyNow(s)) { view.message = 'Waiting for the game to finish resolving…'; return; }
    waitingSince = 0;
    // Card effects update energy, piles and hand at different animation frames.
    // Require a quiet observation interval before paying for a new decision; with a readiness
    // report, combat needs only a brief recheck and other screens a short UI transition.
    const settle = s.ready === true ? (combatTypes.has(s.state_type) ? READY_SETTLE_MS : READY_SCREEN_SETTLE_MS) : SETTLE_MS;
    await new Promise(resolve => setTimeout(resolve, settle));
    if (token !== generation) return;
    const settled = await observe();
    if (fingerprint(settled) !== hash || busyNow(settled)) { view.message = 'Waiting for animations to settle…'; return; }
    // A relic counter at its trigger value is about to reset: re-observe so Jev sees the settled state.
    // The fingerprint treats the trigger value as 0, so a reset during the settle is checked here too.
    const counters = counterWait(settled, counterMemo, Date.now(), COUNTER_SETTLE_MS);
    counterMemo = counters.memo;
    if (counters.wait || triggeredCounters(s).join() !== counters.ids.join()) { view.message = 'Waiting for relic counters to reset…'; return; }
    if (view.decisions >= MAX_DECISIONS || view.inputTokens >= MAX_INPUT_TOKENS) {
      await stop('Session budget reached. Totals persist across restarts; adjust the launch limits deliberately before resuming.', 'budget'); return;
    }
    if (!apiKey) throw new Error('Missing TYPESAFE_API_KEY or private TypeSafe configuration.');
    shadow.decision({ state: planningState, candidates: actions, decisionRef: hash });
    view.message = 'Jev is choosing…';
    view.pending = { startedAt: Date.now(), options: actions.length };
    const start = performance.now();
    const memory=encounterMemory(s,view.events);
    if(planBenefitEnabled)memory.persistentPlan=persistentPlan(s,view.events);
    // Strategy events are logged when they happen (a request when it is posted), not after the decision.
    const logged = new Set();
    const onEvent = async strategyEvent => { logged.add(strategyEvent); await log(strategyEvent); addToHistory(view.strategyHistory, strategyEvent); };
    const result = await (lunaEnabled?assistedDeliberate:planBenefitEnabled?planBenefitDeliberate:hierarchicalDeliberate)({state:planningState,candidates:actions,onEvent,
      recent:memory,strategist:view.decisionMode==='claude'?strategist:null,factsVersion:{jev:0,jev_facts:2,jev_facts_v3:3,claude:3}[view.decisionMode],mapMemory,replay:await replaySource.forState(planningState),cancelled:()=>token!==generation,goldUnclaimed:unclaimedGold(planningState,view.events),
      onStage:stage=>{view.message=stage;view.pending.stage=stage;},
      ask:async payload=>{
        if(token!==generation)throw Error('Decision cancelled.');
        if(view.inputTokens>=MAX_INPUT_TOKENS||view.decisions>=MAX_DECISIONS)throw Error('Session budget reached.');
        view.runeAwareness = payload.state?.hextech_runes ?? null;
        const response=await fetch('https://api.typesafe.ai/v1/systemone',{
          method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},
          body:JSON.stringify({...payload,model:JEV_MODEL}),signal:AbortSignal.timeout(30000),
        }).catch(error=>{throw timeoutMessage(error,'Jev request timed out');});
        if(!response.ok){
          // Report a bounded error code only, never a provider echo of request data.
          const errorBody=await response.json().catch(()=>null);
          const code=errorBody?.detail?.error_type;
          const reason=typeof code==='string'&&/^[a-z_]{1,80}$/.test(code)?` (${code})`:'';
          throw Error(`TypeSafe HTTP ${response.status}${reason}; paused.`);
        }
        const result=await response.json().catch(error=>{throw timeoutMessage(error,'Jev request timed out');});
        view.decisions++;view.inputTokens+=result.usage?.input_tokens??0;
        return result;
      }});
    view.latencyMs = Math.round(performance.now() - start);
    for (const strategyEvent of result.strategyEvents ?? []) if (!logged.has(strategyEvent)) await onEvent(strategyEvent);
    view.model = result.model ?? 'Rules · sole legal action';
    const answer = result.answers?.move;
    const chosen = actions.find(a => a.id === answer?.choice);
    if (!chosen || answer?.type !== 'choice') throw new Error('Jev returned an invalid action ID.');
    const event = { kind: 'decision', stateHash: hash, decisionSource:result.decisionSource??'jev', adviser:result.adviser??null, runAdviser:view.adviser, policy: currentPolicy(), decisionMode:view.decisionMode, strategyConstraint:result.constraint??null, rule:result.rule??null, screenChoice:result.screenChoice??null, escalatedFrom:result.escalatedFrom??null, memory, deliberation:result.deliberation, state: s, chosen, candidates: actions, answer, model: result.model, usage: result.usage, latencyMs: view.latencyMs, observeMs: view.observeMs, preview };
    if (token !== generation) { await log({ ...event, outcome: 'cancelled' }); return; }
    if (preview) { await log({ ...event, outcome: 'preview' }); view.message = `Preview: ${chosen.label}`; return; }
    const fresh = await observe();
    if (fingerprint(fresh) !== hash) { await log({ ...event, outcome: 'stale_rejected' }); view.message = 'State changed; asking again.'; return; }
    if (token !== generation) return;
    // Never retry a mutating request automatically: a timeout can still mean it executed.
    let outcome;
    // If the marker cannot be written, the command is not sent and nothing is uncertain (not_sent).
    await writeDispatchMarker(log, view, { command: chosen.command, stateHash: hash, time: new Date().toISOString() });
    if (token !== generation) { view.uncertainAction = null; await log({kind:'dispatch',outcome:'cancelled_before_send'}); return; }
    try { outcome = await gameRequest('/api/v1/singleplayer', chosen.command); }
    catch (error) {
      // These explicit validation errors happen before enqueueing in STS2MCP.
      // Observe anew and ask a fresh question; never resend the old command.
      if (PRE_ENQUEUE_REJECTION.test(error.message)) {
        view.uncertainAction = null;
        await log({ ...event, outcome: 'game_rejected', message: error.message });
        lastExecuted = ''; nextDecisionAt = Date.now() + 1500;
        view.message = 'Game rejected a stale action; waiting for fresh state.'; return;
      }
      throw error;
    }
    view.uncertainAction = null;
    lastExecuted = hash; view.actions++;
    mapMemory = travelledTo(mapMemory, s, chosen);
    if(result.decisionSource==='forced')view.forcedActions++;
    view.message = token === generation ? chosen.label : 'Paused. The last dispatched move was accepted; wait for its animation before taking over.';
    nextDecisionAt = Date.now() + (s.ready === true ? 0 : COOLDOWN_MS);
    await log({ ...event, outcome: 'executed', result: outcome });
    noteDebuffCard(lampMemory, s, chosen);
  } catch (error) {
    // An operator pause during a decision (a strategist wait or a Jev call) cancels it. The pause
    // record from /api/pause (or shutdown) names the stage that was in flight; it is not an error.
    if (operatorCancel(error, token !== generation)) return;
    stop(error.message === 'fetch failed' ? 'Game bridge unavailable. Launch Slay the Spire 2 with STS2_MCP enabled.' : error.message, null);
    await log({ kind: 'error', message: view.message });
  } finally {
    busy = false; view.pending = null;
    if(view.mode==='paused' && view.message.startsWith('Pausing.'))
      view.message='Paused. No further moves will be sent; wait for any game animation before taking over.';
  }
}

// Sequential runner: at most one model request and one action in flight.
let lastIdleObserve = 0;
let idleObserving = false;
setInterval(async () => {
  if (busy) return;
  if (view.mode === 'running') await step(generation);
  // One idle read at a time and no retries: the next idle tick is the retry, and a slow game
  // must not accumulate overlapping reads.
  else if (!idleObserving && Date.now() - lastIdleObserve >= 600) { lastIdleObserve = Date.now(); idleObserving = true; try { await observe(0); } catch { view.connected = false; } finally { idleObserving = false; } }
}, TICK_MS).unref();

const server = http.createServer(async (req, res) => {
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  // Bind to loopback and reject cross-origin controls / DNS rebinding.
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return json(403, { error: 'Invalid host' });
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(403, { error: 'Invalid origin' });
  try {
    if (req.method === 'GET' && req.url === '/api/status') return json(200, view);
    if (req.method === 'GET' && req.url === '/api/sidecar') return json(200, sidecarView());
    if (req.method === 'GET' && req.url.startsWith('/api/plan-review')) {
      const review = JSON.parse(await readFile(resolve(logDir, 'plan-review.json'), 'utf8'));
      const name = new URL(req.url, 'http://localhost').searchParams.get('case') ?? 'slippery';
      const item = review.cases.find(c => c.name === name);
      if (!item) return json(404, {error:'Replay not found'});
      return json(200, sidecarView({mode:'review', connected:true, pending:null, model:item.event.model, actions:0,
        inputTokens:item.event.usage.input_tokens, state:item.event.state, events:[item.event],
        message:'Recorded-state evaluation. No game actions executed.',
        review:{name:item.name, originalChoice:item.originalChoice, baselineChoice:item.baselineChoice, evaluatedAt:review.evaluatedAt},
      }));
    }
    if (req.method === 'POST') {
      if (req.headers['x-spire-control'] !== '1') return json(403, { error: 'Missing control header' });
      if (req.url === '/api/pause') {
        // Logged when it stops play; stage names what was in flight (a strategist wait, a Jev call).
        const active = view.mode === 'running' || busy;
        await stop(busy ? 'Pausing. A decision or move is still in flight; wait before taking over.'
          : 'Paused. No further moves will be sent; wait for any game animation before taking over.', active ? 'operator' : null, { in_flight: busy, stage: view.pending?.stage ?? null });
        return json(200, { ok: true, pending: busy });
      }
      if (req.url.startsWith('/api/mode/')) {
        const mode = req.url.slice('/api/mode/'.length);
        if (!DECISION_MODES.includes(mode)) return json(404, {error:'Unknown decision mode'});
        if (mode === 'claude' && !strategist) return json(400, {error:'The strategist is unavailable in this launch configuration'});
        if (busy) return json(409, {error:'Wait for the current decision to finish'});
        view.decisionMode = mode;
        if (strategist) { strategist.status.enabled = mode === 'claude'; strategist.status.available = true; }
        view.message = {jev:'Decision mode: Jev baseline (jev-compact-v1). No computed facts, no LLM strategy.',
          jev_facts:'Decision mode: Jev + route/resource facts (jev-compact-v2). No LLM strategy.',
          jev_facts_v3:'Decision mode: Jev + order-aware route facts (jev-compact-v3). No LLM strategy.',
          claude:'Decision mode: Jev + facts + strategist. Keep the strategist session watching for requests.'}[mode];
        await log({kind:'decision_mode',mode}); return json(200,{ok:true});
      }
      if (req.url === '/api/reconcile') {
        if (busy) return json(409, {error:'Wait for the current action to finish'});
        stop('Previous action acknowledged. Observe the game before resuming.', null);
        view.uncertainAction = null; lastExecuted = '';
        await log({kind:'reconciled_by_operator'}); return json(200,{ok:true});
      }
      if (req.url === '/api/run') {
        if (!apiKey) return json(400, { error: 'Missing API key' });
        if (busy || view.uncertainAction) return json(409, {error:'Finish or reconcile the current decision first'});
        generation++; waitingSince = 0; lastExecuted = ''; view.mode = 'running'; view.message = 'Autoplay enabled';
        if (strategist) strategist.status.available = true;
        return json(200, { ok: true });
      }
      if (req.url === '/api/step' || req.url === '/api/preview') {
        if (busy) return json(409, { error: 'Wait for the current decision to finish' });
        stop('Single decision', null); const token = generation;
        void step(token, req.url === '/api/preview'); return json(200, { ok: true });
      }
    }
    if (req.method === 'GET' && ['/', '/sidecar'].includes(req.url?.split('?')[0])) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end(await readFile(resolve(root, req.url.startsWith('/sidecar') ? 'sidecar.html' : 'index.html')));
    }
    json(404, { error: 'Not found' });
  } catch { json(500, { error: 'Local server error' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Jev plays the Spire: http://127.0.0.1:${port}\nKey configured: ${Boolean(apiKey)}\nDecision log: ${logFile}`));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; await stop('Stopped', 'shutdown'); server.close();
  await shadow.close().catch(() => {});
  // Pending dispatch was persisted before sending; retain that marker on interruption,
  // and write the latest snapshot (counters, strategist status) before exiting.
  await flushSnapshot().catch(() => {});
  await unlink(lockFile).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('error', async error => { await unlink(lockFile).catch(() => {}); console.error(error.message); process.exit(1); });
