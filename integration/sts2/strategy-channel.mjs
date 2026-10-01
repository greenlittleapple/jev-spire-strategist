// File channel between the runner and the operator's Claude Code session.
// One outstanding request; an answer names the request ID it was written for.
import {readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

async function readJson(file) {
 try { return JSON.parse(await readFile(file,'utf8')); }
 catch(error){ if(error.code==='ENOENT')return null; throw error; }
}
async function writeJson(file,value) {
 await writeFile(file+'.tmp',JSON.stringify(value,null,1),{mode:0o600});
 await rename(file+'.tmp',file);
}

export function fileChannel(dir) {
 const requestFile=resolve(dir,'request.json'),answerFile=resolve(dir,'answer.json');
 return {
  dir,requestFile,answerFile,
  current:()=>readJson(requestFile),
  pendingAnswer:()=>readJson(answerFile),
  // Session side: the request if it is still unanswered. take() deletes the request before the
  // answer, so a request that is still there after no answer was found has not been consumed.
  async pending() {
   const request=await readJson(requestFile);
   if(!request||(await readJson(answerFile))?.id===request.id)return null;
   return (await readJson(requestFile))?.id===request.id?request:null;
  },
  async post(fields) {
   await mkdir(dir,{recursive:true,mode:0o700});
   const request={id:randomUUID(),createdAt:new Date().toISOString(),...fields};
   await writeJson(requestFile,request);
   return request;
  },
  // Runner side: consume an answer for this request, if one exists.
  async take(id) {
   const answer=await readJson(answerFile);
   if(!answer)return null;
   if(answer.id!==id){await unlink(answerFile).catch(()=>{});return null;}
   // Request first: a session polling between the two deletes must not find the request
   // without its answer and answer it again.
   await unlink(requestFile).catch(()=>{});
   await unlink(answerFile).catch(()=>{});
   return answer;
  },
  // A request left from another run (an earlier runner session, or a run since abandoned) is moved to
  // request.stale-<id>.json, with its answer if one was written, so no strategist answers it. Returns the
  // archived request, or null. The runner calls it on its first observation and when the run changes.
  async archiveOtherRun(runId) {
   const request=await readJson(requestFile);
   const other=request?.stamp?.run_id;
   if(!runId||!other||other===runId)return null;
   const name=`request.stale-${String(request.id).slice(0,8)}.json`;
   await rename(requestFile,resolve(dir,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
   if((await readJson(answerFile))?.id===request.id)await unlink(answerFile).catch(()=>{});
   return {...request,archivedAs:name};
  },
  // Session side: answer only the request that was read.
  async answer(id,plan) {
   const request=await readJson(requestFile);
   if(!request)throw Error('No strategy request is pending.');
   if(request.id!==id)throw Error(`Request ${id} was replaced by ${request.id}; read it with "show" and answer that one.`);
   await writeJson(answerFile,{id,plan,answeredAt:new Date().toISOString()});
   return request;
  },
 };
}
