import fs from 'node:fs';
import { llmChat } from '/Users/thomasseirer/repos/gcig-app/server/src/services/llm.js';
const T=fs.readFileSync('/private/tmp/claude-501/-Users-thomasseirer/811cf756-8d89-4232-8a0e-27cecc15d97d/scratchpad/.tok','utf8').trim();
const API='https://gcig-api.onrender.com/api';
const H={Authorization:'Bearer '+T,'Content-Type':'application/json'};
const p=await (await fetch(`${API}/research/projects/2`,{headers:H})).json();
const qs=p.questions||[], claims=p.claims||[];
console.log(`${claims.length} claims, ${qs.length} questions\n`);
qs.forEach((q,i)=>console.log(`  Q${q.id}: ${q.text.slice(0,80)}`));

const SYS=`You map research claims to the questions a project set out to answer.

You are given numbered QUESTIONS and numbered CLAIMS from field interviews about premium chocolate retail.

For each claim, decide which ONE question it is EVIDENCE FOR OR AGAINST, or none.

The bar is high. A claim must be about the same SUBJECT as the question, not merely share a word or a number with it.

Worked examples of what NOT to do:
  Q: "Does Lindt hold roughly 20% of the premium chocolate shelf?"
  Claim: "30% of stock sells in the first half of the week"
  -> null. This is about restock timing. It shares the shape of a percentage and nothing else.

  Q: "Does Lindt hold roughly 20% of the premium chocolate shelf?"
  Claim: "no, like, just like I said, like 30% done"
  -> null. This is a staffer describing how far through a restock they are.

  Q: "Is the premium buyer price-insensitive enough to absorb repeated increases?"
  Claim: "Hershey's sells more because they are cheaper"
  -> null. That is about the mainstream buyer choosing on price, which is a different population.

A shelf-share question needs a claim about facings, shelf space, or share of the set.
A price-sensitivity question needs a claim about how buyers responded to a price change.
A pass-through question needs a claim about costs moving into prices.

Reply with strict JSON only:
{"links":[{"claimIndex":0,"questionId":12,"why":"under 10 words"}]}
Use questionId null for no link. "claimIndex" MUST match the input number.

Most claims will be null. That is the expected outcome and it is correct — field research turns up plenty that answers something nobody asked. A padded coverage number is worse than an honest gap, because it tells the team a question is settled when nothing has actually been established.`;
;

const qList=qs.map(q=>`Q${q.id}: ${q.text}`).join('\n');
const links=new Map();
let rawDbg='';
for (let i=0;i<claims.length;i+=8){
  const batch=claims.slice(i,i+15);
  const cList=batch.map((c,j)=>`${j}. [${c.kind}] ${c.text}`).join('\n');
  try{
    const raw=await llmChat({messages:[{role:'system',content:SYS},{role:'user',content:`QUESTIONS\n${qList}\n\nCLAIMS\n${cList}`}],jsonMode:true,temperature:0,timeoutMs:120000,preferQuality:true});
    rawDbg=raw;
    for(const l of (JSON.parse(raw).links||[])){
      const c=batch[l.claimIndex];
      if(!c) continue;
      const qid=Number(l.questionId);
      if(qs.some(q=>q.id===qid)) links.set(c.id,{qid,why:l.why});
    }
  }catch(e){ console.log(`\n  batch ${i} failed: ${e.message}; raw=${String(rawDbg).slice(0,120)}`); }
  process.stdout.write(`\r  mapped ${Math.min(i+15,claims.length)}/${claims.length}`);
}
console.log('');
let ok=0;
for(const [cid,v] of links){
  const r=await fetch(`${API}/research/claims/${cid}/link`,{method:'POST',headers:H,body:JSON.stringify({questionId:v.qid})});
  if(r.ok) ok++;
}
console.log(`\nlinked ${ok} of ${claims.length} claims (${claims.length-ok} left unlinked as answering nothing we asked)`);
