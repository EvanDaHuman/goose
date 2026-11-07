import { notFound } from "next/navigation";
import { Replay } from "@/components/Replay";
import { Back } from "@/components/ui";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await q<any>("SELECT id, title, kind, created_at FROM jobs WHERE id = $1", [id]);
  if (!job.length) notFound();
  const events = await q<any>("SELECT id, at, actor, kind, important, summary FROM events WHERE job_id = $1 ORDER BY id", [id]);
  return (
    <main className="wrap narrow">
      <Back href={`/ops/jobs/${id}`}>Back to the job</Back>
      <div className="banner warn"><b>REPLAY - not live</b><span>This replays the recorded activity of {id} ({job[0].title}), which ran on{" "}
        {new Date(events[0]?.at ?? job[0].created_at).toLocaleString("en-US")}. Nothing is executing now.</span></div>
      <h1 className="section">Replay of {id}</h1>
      <Replay events={events.map((e) => ({ ...e, at: new Date(e.at).toISOString() }))} />
    </main>
  );
}
