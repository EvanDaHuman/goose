import Link from "next/link";

export default function NotFound() {
  return (
    <main className="wrap narrow">
      <h1>We could not find that page</h1>
      <p className="muted">Job pages open only from the private link we send to the customer. If you followed a link from us,
        check that it was copied in full, or reply to our last message and we will send it again.</p>
      <p><Link href="/">See what we upgrade</Link> · <Link href="/start">Start a job</Link></p>
    </main>
  );
}
