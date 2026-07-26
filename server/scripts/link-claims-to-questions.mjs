import fs from 'node:fs';
import { llmChat } from '/Users/thomasseirer/repos/gcig-app/server/src/services/llm.js';
const T=fs.readFileSync('/private/tmp/claude-501/-Users-thomasseirer/811cf756-8d89-4232-8a0e-27cecc15d97d/scratchpad/.tok','utf8').trim();
const API='https://gcig-api.onrender.com/api';
const H={Authorization:'Bearer '+T,'Content-Type':'application/json'};
const p=await (await fetch(`${API}/research/projects/2`,{headers:H})).json();
const qs=p.questions||[], claims=p.claims||[];
console.log(`${claims.length} claims, ${qs.length} questions\n`);
qs.forEach((q,i)=>console.log(`  Q${q.id}: ${q.text.slice(0,80)}`));

let failed=0, batches=0;
const SYS = `You map research claims to the questions a project set out to answer.

You are given numbered QUESTIONS and numbered CLAIMS from field interviews.

For each claim, decide which ONE question it is EVIDENCE FOR OR AGAINST, or none.

The test is SUBJECT. A claim belongs to a question when it speaks to the thing that question asks about. A shared number or a shared word is not enough on its own — but a difference in wording is not a reason to reject a claim that plainly answers the question.

  "premium chocolate is restocked twice a week"        -> a question about restock frequency. Link it.
  "Hershey's sells more than premium chocolate by far" -> a question comparing Lindt to mainstream brands. Link it.
  "we put up about six Lindt and a case of Hershey"    -> a question about per-brand replacement counts. Link it.
  "30% of stock sells in the first half of the week"   -> a question about SHELF SHARE. No. It is about sell-through timing and shares only the shape of a percentage.

Match to the MOST SPECIFIC question that fits. If a claim answers both a narrow question and a broad one, choose the narrow one.

Reply with strict JSON only:
{"links":[{"claimIndex":0,"questionId":12,"why":"under 10 words"}]}
Use questionId null for no link. "claimIndex" MUST match the input number.

Claims that answer nothing asked are normal and should be left null. But do not leave a claim unlinked merely because it is phrased differently from the question. A padded coverage number is a lie; so is an empty one.`;
;

const qList=qs.map(q=>`Q${q.id}: ${q.text}`).join('\n');
const links=new Map();
let rawDbg='';
for (let i=0;i<claims.length;i+=8){
  const batch=claims.slice(i,i+15);
  const cList=batch.map((c,j)=>`${j}. [${c.kind}] ${c.text}`).join('\n');
  batches++;
  try{
    const raw=await llmChat({messages:[{role:'system',content:SYS},{role:'user',content:`QUESTIONS\n${qList}\n\nCLAIMS\n${cList}`}],jsonMode:true,temperature:0,timeoutMs:120000,preferQuality:true,localModel:'qwen2.5:14b-instruct-q4_K_M'});
    if(raw==null) throw new Error('no reply from any provider');
    rawDbg=raw;
    for(const l of (JSON.parse(raw).links||[])){
      const c=batch[l.claimIndex];
      if(!c) continue;
      const qid=Number(l.questionId);
      if(qs.some(q=>q.id===qid)) links.set(c.id,{qid,why:l.why});
    }
  }catch(e){ failed++; console.log(`\n  batch ${i} failed: ${e.message}; raw=${String(rawDbg).slice(0,120)}`); }
  process.stdout.write(`\r  mapped ${Math.min(i+15,claims.length)}/${claims.length}`);
}
console.log('');
let ok=0;
for(const [cid,v] of links){
  const r=await fetch(`${API}/research/claims/${cid}/link`,{method:'POST',headers:H,body:JSON.stringify({questionId:v.qid})});
  if(r.ok) ok++;
}
// A batch that never got a reply is not a batch that found nothing to
// link. Reporting "answering nothing we asked" after every call failed
// turns a dead model into a research finding, which is the exact shape
// of mistake this whole ledger exists to prevent.
if (failed) {
  console.log(`\n${failed} of ${batches} batches never got a reply from the model — ` +
    `their claims were NOT considered. Fix the model and re-run before trusting coverage.`);
}
console.log(`linked ${ok} of ${claims.length} claims` +
  (failed ? ` (from the ${batches - failed} batches that ran)` : ` (${claims.length-ok} left unlinked as answering nothing we asked)`));
