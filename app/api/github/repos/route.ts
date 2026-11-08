import { githubAppConfigured, listConnectedRepos, sessionFrom } from "@/lib/github";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

// The repositories the signed-in customer gave the Goose App access to (for the picker on /start).
export async function GET(req: Request) {
  if (!githubAppConfigured()) return json({ configured: false, connected: false, repos: [] });
  const session = sessionFrom(req);
  if (!session) return json({ configured: true, connected: false, repos: [] });
  try {
    return json({ configured: true, connected: true, login: session.login, repos: await listConnectedRepos(session) });
  } catch (e) {
    console.error("Listing GitHub repositories failed:", e);
    return json({ configured: true, connected: true, login: session.login, repos: [], error: "GitHub didn't list your repositories. Try connecting again." });
  }
}
