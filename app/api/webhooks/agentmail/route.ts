import { agentMailInboundStatus,receiveAgentMail,verifyAgentMail } from "@/lib/integrations/agentmail";
import { fail,json } from "@/lib/http";
export const runtime="nodejs";
const MAX_BYTES=256*1024;
export async function POST(req:Request){
  if(!agentMailInboundStatus().ready)return fail("AgentMail inbound webhook is not configured",503);
  if(Number(req.headers.get("content-length")??0)>MAX_BYTES)return fail("Webhook payload is too large",413);
  const chunks:Uint8Array[]=[];let size=0;
  const reader=req.body?.getReader();
  if(reader){try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BYTES){await reader.cancel();return fail("Webhook payload is too large",413);}chunks.push(part.value);}}finally{reader.releaseLock();}}
  const raw=Buffer.concat(chunks);let verified:ReturnType<typeof verifyAgentMail>;
  try{verified=verifyAgentMail(raw,req.headers);}catch{return fail("Invalid AgentMail webhook signature or payload",401);}
  try{return json(await receiveAgentMail(raw,verified.event,verified.deliveryId));}
  catch(e){return fail(e instanceof Error?e.message:"Invalid AgentMail event");}
}
