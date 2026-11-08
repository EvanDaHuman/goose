import { requireOperator } from "@/lib/operatorAuth";
import { positiveId } from "@/lib/commerce";
import { one } from "@/lib/db";
import { fail,json } from "@/lib/http";
export async function GET(req:Request,ctx:{params:Promise<{id:string}>}){
  const denied=await requireOperator(req);if(denied)return denied;
  try{const {id}=await ctx.params;const receipt=await one("SELECT * FROM commerce_inbound_messages WHERE id=$1",[positiveId(id)]);if(!receipt)return fail("Inbound receipt not found",404);
    const res=json(receipt);res.headers.set("Cache-Control","private, no-store");return res;
  }catch{return fail("Invalid receipt ID");}
}
