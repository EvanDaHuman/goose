import Link from "next/link";

export function OpsNav({ active }: { active: "delivery" | "business" | "company" | "agents" }) {
  return <nav className="ops-tabs" aria-label="Company operations">{[
    ["delivery", "/ops", "Delivery"], ["business", "/ops/business", "Customer operations"], ["company", "/ops/company", "Company & growth"], ["agents", "/ops/naive", "Naïve agents"],
  ].map(([key, href, label]) => <Link href={href} key={key} className={active === key ? "active" : undefined} aria-current={active === key ? "page" : undefined}>{label}</Link>)}</nav>;
}
