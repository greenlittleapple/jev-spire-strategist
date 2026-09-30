// Removes encounter plans that a consult during a fight wrote into the playbook (before v3.18 a
// non-empty fight plan from low_hp, unknown_mechanic or death_countdown replaced the saved plan).
// Those encounters then ask for a plan again at their next start.
// Dry run by default: prints what would change. --write backs the file up first, then writes it.
//   node integration/sts2/playbook-clean.mjs [--file path/to/playbook.json] [--write]
import {readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {FIGHT_START_REASONS} from './playbook.mjs';

// Consult reasons that fire during a fight. Other sources (fight starts, post_run_review edits) stay.
export const MID_FIGHT_REASONS=new Set(['low_hp','unknown_mechanic','death_countdown']);

export function cleanPlaybook(book){
 const entries=book?.entries??{},removed=[],kept={},other=[];
 for(const [key,e] of Object.entries(entries)){
  if(MID_FIGHT_REASONS.has(e?.source))removed.push({key,source:e.source,run:e.run??null,floor:e.floor??null,play_first:e.play_first??[],plan:e.plan});
  else{kept[key]=e;if(!FIGHT_START_REASONS.has(e?.source))other.push({key,source:e?.source??null});}
 }
 return {book:{...book,entries:kept},removed,other,total:Object.keys(entries).length};
}

export function report({removed,other,total},{path,write}){
 const lines=[`${path}: ${total} entries, ${removed.length} saved by a mid-fight consult${write?' removed':' would be removed (dry run; --write to apply)'}.`];
 for(const r of removed)lines.push(`- ${r.key} (${r.source}, floor ${r.floor}${r.play_first.length?`, play_first ${r.play_first.join(', ')}`:''}): ${r.plan}`);
 if(other.length)lines.push(`Kept with a source that is not a fight start: ${other.map(o=>`${o.key} (${o.source})`).join('; ')}.`);
 return lines.join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const arg=k=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:null;
 const path=resolve(arg('--file')??resolve(root,'.private/sts2/strategy/playbook.json'));
 const write=process.argv.includes('--write');
 const result=cleanPlaybook(JSON.parse(await readFile(path,'utf8')));
 if(write&&result.removed.length){
  const backup=`${path}.bak-${new Date().toISOString().replace(/[:.]/g,'-')}`;
  await copyFile(path,backup);
  await writeFile(path+'.tmp',JSON.stringify(result.book,null,1));
  await rename(path+'.tmp',path);
  console.log(`Backup: ${backup}`);
 }
 console.log(report(result,{path,write}));
}
