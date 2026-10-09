/**
 * Build-order item 4 (Samuel's brief): the "serviço emissor" — the server half of the run-start
 * flow. Plain node:http, no framework: two JSON endpoints is not enough surface to justify a new
 * dependency.
 *
 *   POST /api/runs/start   { userWallet, run_id, scenario_id, agent_repo, agent_commit,
 *                            model_id, evaluator_commit, fixture_hash }
 *     -> { wireTransactionBase64, memo }  (hot-signer-signed, user's slot still empty)
 *
 *   POST /api/runs/submit  { wireTransactionBase64 }  (fully signed — Phantom filled the slot)
 *     -> { signature }
 *
 * Deliberately stateless: this process holds no record of in-flight runs. The browser carries
 * the partially-signed tx from /start to /submit itself. Nothing here writes to Supabase yet —
 * that's wiring work for whoever builds the backend from CONTEXTO.md's "Supabase do Itera"
 * section (todo, separate from this service).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Address, KeyPairSigner } from '@solana/kit';
import { setupClient, loadHotSigner, type Client } from './client.js';
import { CONFIG, hotSignerKeypairPath } from './config.js';
import { buildPartiallySignedRunStartTx, submitSignedRunStartTx, type RunStartMemoPayload } from './run-start-tx.js';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CONFIG.CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  res.end(payload);
}

function isRunStartPayload(body: unknown): body is RunStartMemoPayload & { userWallet: string } {
  if (typeof body !== 'object' || body === null) return false;
  const required = ['userWallet', 'run_id', 'scenario_id', 'agent_repo', 'agent_commit', 'model_id', 'evaluator_commit', 'fixture_hash'];
  return required.every((key) => typeof (body as Record<string, unknown>)[key] === 'string');
}

async function main(): Promise<void> {
  const client: Client = await setupClient();
  const hotSigner: KeyPairSigner = await loadHotSigner(hotSignerKeypairPath());
  console.log(`Run-issuer hot signer (fee payer): ${hotSigner.address}`);

  const server = createServer((req, res) => {
    handleRequest(req, res, client, hotSigner).catch((error) => {
      console.error('Request failed:', error);
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`Run-issuer listening on :${CONFIG.PORT}`);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, client: Client, hotSigner: KeyPairSigner): Promise<void> {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/runs/start') {
    const body = await readJsonBody(req);
    if (!isRunStartPayload(body)) {
      sendJson(res, 400, { error: 'missing or invalid field(s): userWallet, run_id, scenario_id, agent_repo, agent_commit, model_id, evaluator_commit, fixture_hash' });
      return;
    }
    const { userWallet, ...payload } = body;
    const result = await buildPartiallySignedRunStartTx(client, hotSigner, userWallet as Address, payload);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/runs/submit') {
    const body = await readJsonBody(req);
    const wireTransactionBase64 = (body as Record<string, unknown>)?.wireTransactionBase64;
    if (typeof wireTransactionBase64 !== 'string') {
      sendJson(res, 400, { error: 'missing or invalid field: wireTransactionBase64' });
      return;
    }
    const signature = await submitSignedRunStartTx(client, wireTransactionBase64);
    sendJson(res, 200, { signature });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

main().catch((error) => {
  console.error('Run-issuer failed to start:', error);
  process.exit(1);
});
