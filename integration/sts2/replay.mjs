// Replay mode: on a seeded rerun, take the non-combat choices a reference run made
// whenever the same screen shows exactly the same options. Combat is never replayed.
// Configured by .private/sts2/replay.json: {source_run, target_run}.
import {createReadStream} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join} from 'node:path';

const combatScreens=new Set(['monster','elite','boss','hand_select']);
export const replayKey=(state,candidates)=>`${state.run?.act}:${state.run?.floor}:${state.state_type}:${JSON.stringify(candidates.map(c=>c.label).sort())}`;

// Builds {key: [chosen labels in order]} from a run's logged decisions.
export function replayTable(records) {
 const table={};
 for(const r of records){
  if(r.kind!=='decision'||!r.state||!r.chosen||!r.candidates?.length||combatScreens.has(r.state.state_type))continue;
  (table[replayKey(r.state,r.candidates)]??=[]).push(r.chosen.label);
 }
 return table;
}

async function runRecords(runsDir,runId) {
 const records=[],suffix=String(runId).split(':').pop();
 for(const name of (await readdir(runsDir)).filter(n=>n.endsWith('.jsonl'))){
  for await(const line of createInterface({input:createReadStream(join(runsDir,name))})){
   if(!line.includes(suffix))continue;
   try{const r=JSON.parse(line);if(String(r.state?.run?.live_id??'').endsWith(suffix))records.push(r);}catch{}
  }
 }
 return records;
}

export function replayer({configPath,runsDir}) {
 let loaded=null;
 return {
  // Returns the active replay for this run, loading the reference decisions once.
  async forState(state){
   let config;
   try{config=JSON.parse(await readFile(configPath,'utf8'));}catch{return null;}
   if(!config?.source_run||!config.target_run||String(state.run?.live_id)!==String(config.target_run))return null;
   if(loaded?.source!==config.source_run){
    loaded={source:config.source_run,table:replayTable(await runRecords(runsDir,config.source_run)),used:{},diverged:new Set()};
   }
   return loaded;
  },
 };
}

// The logged choice for this screen, or null when the options differ from the reference run.
export function replayChoice(replay,state,candidates) {
 if(!replay||combatScreens.has(state.state_type))return null;
 const key=replayKey(state,candidates),labels=replay.table[key];
 if(!labels)return null;
 const n=replay.used[key]??0;
 const label=labels[Math.min(n,labels.length-1)];
 const choice=candidates.find(c=>c.label===label);
 if(!choice)return null;
 replay.used[key]=n+1;
 return choice;
}
