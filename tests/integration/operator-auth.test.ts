import test from "node:test";
import assert from "node:assert/strict";
import { isOperatorRequest, operatorSession, requireOperator, validOperatorSession } from "../../lib/operatorAuth";
import { GET as artifactGet } from "../../app/api/jobs/[id]/artifacts/[aid]/route";
import { GET as sourceGet } from "../../app/api/jobs/[id]/source/route";
import { POST as previewPost } from "../../app/api/jobs/[id]/preview/route";
import { POST as tryPost } from "../../app/api/try/[id]/route";

test("an ops query flag never authorizes access to customer files or execution",async()=>{
  const get=new Request("http://localhost:3100/api/jobs/GS-1001/source?ops=1");
  const post=new Request("http://localhost:3100/api/jobs/GS-1001/preview?ops=1",{method:"POST"});
  const params=Promise.resolve({id:"GS-1001"});
  assert.equal((await artifactGet(get,{params:Promise.resolve({id:"GS-1001",aid:"1"})})).status,401);
  assert.equal((await sourceGet(get,{params})).status,401);
  assert.equal((await previewPost(post,{params})).status,401);
  assert.equal((await tryPost(post,{params})).status,401);
});

test("operator sessions expire, reject tampering and isolate mutation origins", async()=>{
  const previous=process.env.GOOSE_OPERATOR_TOKEN;
  process.env.GOOSE_OPERATOR_TOKEN="test-operator-secret-with-at-least-24-chars";
  try {
    const now=Date.now(), session=operatorSession(now);
    assert.equal(validOperatorSession(session,now),true);
    assert.equal(validOperatorSession(session,now+13*3600_000),false);
    assert.equal(validOperatorSession(session+"x",now),false);
    const headers={cookie:`goose_operator=${session}`};
    assert.equal(isOperatorRequest(new Request("http://localhost:3100/ops",{headers})),true);
    assert.equal((await requireOperator(new Request("http://localhost:3100/api/ops/settings",{method:"POST",headers})))?.status,403);
    assert.equal(await requireOperator(new Request("http://localhost:3100/api/ops/settings",{method:"POST",headers:{...headers,origin:"http://localhost:3100"}})),null);
    assert.equal((await requireOperator(new Request("http://localhost:3100/api/ops/settings")))?.status,401);
  } finally { if(previous===undefined)delete process.env.GOOSE_OPERATOR_TOKEN;else process.env.GOOSE_OPERATOR_TOKEN=previous; }
});
