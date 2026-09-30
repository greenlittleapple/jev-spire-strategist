// Session-side tool for answering the runner's strategy requests.
//   wait            block until an unanswered request exists, then print its ID
//   show            print the pending request (instructions, schema, brief)
//   answer ID FILE  validate a plan JSON file (or - for stdin) and deliver it
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileChannel} from './strategy-channel.mjs';
import {validatePlan} from './strategy.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const channel=fileChannel(process.env.STRATEGY_DIR??resolve(root,'.private/sts2/strategy'));
const [command,...args]=process.argv.slice(2);
// Expected failures print one line and exit 1, without a stack trace.
const fail=message=>{console.error(message);process.exit(1);};

if(command==='wait'){
 for(;;){
  const request=await channel.pending();
  if(request){console.log(`Strategy request ${request.id} (${request.stamp.reason}, act ${request.stamp.act} floor ${request.stamp.floor})`);break;}
  await new Promise(r=>setTimeout(r,1000));
 }
} else if(command==='show'){
 const request=await channel.current();
 if(!request)console.log('No strategy request is pending.');
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
