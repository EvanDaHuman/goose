import test from "node:test";
import assert from "node:assert/strict";
import { isOperatorRequest, operatorSession, requireOperator, validOperatorSession } from "../../lib/operatorAuth";

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
