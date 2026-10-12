import { Router } from "express";
import { commitMarkdownFile, ManifestsRepoError } from "../domain/manifests-repo.js";

interface SubmitBody {
  vendorName?: unknown;
  agentName?: unknown;
  fileName?: unknown;
  content?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

/**
 * POST /agent-endpoint-manifests — PreparePage's file-upload replacement for a typed-in
 * "Controlled endpoint" URL. The vendor uploads a small JSON file ({"endpointUrl": "https://..."}),
 * this route validates and extracts the URL (same https-only rule as POST /evaluations), and
 * commits the raw uploaded file to the public manifests repo for an audit trail — reusing
 * commitMarkdownFile from the evaluation-requests flow. That function only writes .md files (the
 * one real enforcement point against a non-.md push via the deploy key — see manifests-repo.ts),
 * so the uploaded JSON is wrapped in a fenced code block inside a generated .md file rather than
 * committed as raw .json.
 *
 * Path today: `agents/<vendor-slug>/<agent-slug>/<timestamp>.md` — vendor/agent are free text the
 * submitter types, since there is no login system yet (see api.ts/PreparePage.tsx). Once real
 * login+password auth exists (product direction, 2026-10-12), add ONE level on top of this same
 * layout: `agents/<user-id>/<vendor-slug>/<agent-slug>/...`, both here and in the DB's vendor/agent
 * ownership, so a logged-in user can list and review their own past runs/results. Do not fake a
 * user-id level with a session/browser-generated id in the meantime — there is no real identity to
 * key it on yet, and a fake id would mislead whoever reads the git history later.
 */
export function createAgentEndpointManifestsRouter(): Router {
  const router = Router();

  router.post("/agent-endpoint-manifests", async (req, res) => {
    const body = req.body as SubmitBody;
    if (!isNonEmptyString(body.vendorName) || !isNonEmptyString(body.agentName)) {
      res.status(400).json({ error: "vendorName and agentName are required" });
      return;
    }
    if (!isNonEmptyString(body.fileName) || !isNonEmptyString(body.content)) {
      res.status(400).json({ error: "fileName and content are required" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.content);
    } catch {
      res.status(400).json({ error: "content must be valid JSON" });
      return;
    }
    const endpointUrlRaw = (parsed as { endpointUrl?: unknown } | null)?.endpointUrl;
    if (!isNonEmptyString(endpointUrlRaw)) {
      res.status(400).json({ error: "uploaded file must contain an \"endpointUrl\" string field" });
      return;
    }
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(endpointUrlRaw);
    } catch {
      res.status(400).json({ error: "endpointUrl must be a valid URL" });
      return;
    }
    if (endpointUrl.protocol !== "https:") {
      res.status(400).json({ error: "endpointUrl must use https" });
      return;
    }

    const vendorSlug = slugify(body.vendorName as string);
    const agentSlug = slugify(body.agentName as string);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `agents/${vendorSlug}/${agentSlug}/${timestamp}.md`;

    const markdown = [
      `# Agent endpoint manifest`,
      ``,
      `- Vendor: ${body.vendorName}`,
      `- Agent: ${body.agentName}`,
      `- Submitted at: ${new Date().toISOString()}`,
      `- Source file: ${body.fileName}`,
      ``,
      "```json",
      body.content as string,
      "```",
      ``,
    ].join("\n");

    try {
      const { commitSha } = await commitMarkdownFile(path, markdown, `Agent endpoint manifest: ${body.vendorName}/${body.agentName}`);
      res.status(201).json({ commitSha, endpointUrl: endpointUrl.toString() });
    } catch (e) {
      const message = e instanceof ManifestsRepoError ? e.message : e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: `could not commit the manifest: ${message}` });
    }
  });

  return router;
}
