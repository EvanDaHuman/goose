import { BusinessDashboard } from "@/components/BusinessDashboard";
import { OpsNav } from "@/components/OpsNav";

export const dynamic = "force-dynamic";

export default function Business() {
  return <main className="wrap"><OpsNav active="business" /><div className="ops-title"><div><div className="kicker">The company behind the work</div><h1>Customer operations</h1><p>Inquiries, communication, billing, support, and ongoing maintenance.</p></div></div><BusinessDashboard /></main>;
}
