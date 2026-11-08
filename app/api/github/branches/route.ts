import { GithubError, listBranches, parseRepoInput, sessionFrom } from "@/lib/github";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Branches of one repository: through the customer's App installation when they connected it, otherwise
// as a public repository.
export async function GET(req: Request) {
  const input = new URL(req.url).searchParams.get("repo") ?? "";
  const ref = parseRepoInput(input);
  if (!ref) return fail("Paste a GitHub repository address, like https://github.com/your-org/your-app.");
  try {
    return json(await listBranches(ref, sessionFrom(req)));
  } catch (e) {
    if (e instanceof GithubError) return fail(e.message, e.status);
    console.error("Listing branches failed:", e);
    return fail("GitHub didn't answer. Try again in a moment.", 502);
  }
}
