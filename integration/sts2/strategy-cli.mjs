// Session-side tool for answering the runner's strategy requests.
//   wait            block until an unanswered request exists, then print its ID
//   show            print the pending request (instructions, schema, brief)
//   answer ID FILE  validate a plan JSON file (or - for stdin) and deliver it
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {fileChannel} from './strategy-channel.mjs';
import {validatePlan} from './strategy.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const channel=fileChannel(process.env.STRATEGY_DIR??resolve(root,'.private/sts2/strategy'));
// The runner's dashboard snapshot names the run it is on (runId). A channel set by STRATEGY_DIR has no
// default snapshot; STRATEGY_SESSION_FILE names one.
const sessionFile=process.env.STRATEGY_SESSION_FILE??(process.env.STRATEGY_DIR?null:resolve(root,'.private/sts2/runs/session.json'));
const runnerRun=async()=>{
 if(!sessionFile)return null;
 try{const [text,info]=await Promise.all([readFile(sessionFile,'utf8'),stat(sessionFile)]);const runId=JSON.parse(text).runId;return runId?{runId,writtenAt:info.mtimeMs}:null;}
 catch{return null;}
};
// A request for a run the runner is no longer on (left from an earlier runner session) is archived, not
// answered. Only a snapshot written after the request was posted counts: an older one may predate a new run.
// Returns 'stale' (archived), 'unsure' (the snapshot is older than the request) or null (current, or unknown).
async function staleRequest(request) {
 const run=request?.stamp?.run_id,runner=await runnerRun();
 if(!run||!runner||runner.runId===run)return null;
 if(runner.writtenAt<Date.parse(request.createdAt))return 'unsure';
 const archived=await channel.archiveOtherRun(runner.runId);
 if(archived)console.error(`Archived request ${archived.id} (${archived.stamp.reason}) for run ${run}: the runner is on run ${runner.runId}.`);
 return 'stale';
}
const [command,...args]=process.argv.slice(2);
// Expected failures print one line and exit 1, without a stack trace.
const fail=message=>{console.error(message);process.exit(1);};

if(command==='wait'){
 for(;;){
  const request=await channel.pending();
  if(request&&!await staleRequest(request)){console.log(`Strategy request ${request.id} (${request.stamp.reason}, act ${request.stamp.act} floor ${request.stamp.floor})`);break;}
  await new Promise(r=>setTimeout(r,1000));
 }
} else if(command==='show'){
 const request=await channel.current();
 if(!request||await staleRequest(request)==='stale')console.log('No strategy request is pending.');
 else console.log(JSON.stringify({id:request.id,createdAt:request.createdAt,instructions:request.instructions,schema:request.schema,brief:request.brief}));
} else if(command==='answer'&&args.length===2){
 const [id,file]=args;
 const raw=file==='-'?await new Promise(r=>{let s='';process.stdin.on('data',d=>s+=d).on('end',()=>r(s));})
  :await readFile(file,'utf8').catch(error=>fail(`Cannot read ${file}: ${error.code??error.message}`));
 let plan;
 try{plan=JSON.parse(raw);}catch(error){fail(`${file==='-'?'Standard input':file} is not valid JSON: ${error.message}`);}
 const errors=validatePlan(plan);
 const request=await channel.current();
 if(request?.id===id&&Array.isArray(plan.allowed_option_ids))for(const option of plan.allowed_option_ids)
  if(!Object.hasOwn(request.stamp.option_keys,option))errors.push(`allowed_option_ids: ${option} is not an option on this screen`);
 // Screens without map data cannot check nodes; a carried-over route is checked on the next map screen.
 if(request?.id===id&&Array.isArray(plan.route_path)&&request.stamp.route_nodes?.length)for(const node of plan.route_path)
  if(!(request.stamp.route_nodes??[]).includes(node))errors.push(`route_path: ${node} is not a node on this act's map`);
 if(errors.length){console.error(errors.join('\n'));process.exit(1);}
 // A replaced request or none pending: the channel's message says what to do next.
 await channel.answer(id,plan).catch(error=>fail(error.message));
 console.log(`Delivered plan for ${id}.`);
} else {
 console.error('Usage: strategy-cli.mjs wait | show | answer <request-id> <plan.json|->');
 process.exit(2);
}
