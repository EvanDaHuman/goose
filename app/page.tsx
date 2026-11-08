import type { Metadata } from "next";
import { Landing } from "@/components/site/Landing";
import { SiteShell } from "@/components/site/SiteShell";
import "./site.css";

export const metadata: Metadata = {
  title: { absolute: "Goose · Migrations that land" },
  description: "Goose moves your code and data to a modern stack, proves nothing broke, and bills you only when the checks pass.",
};

export default function Home() {
  return (
    <SiteShell overHero>
      <Landing />
    </SiteShell>
  );
}
