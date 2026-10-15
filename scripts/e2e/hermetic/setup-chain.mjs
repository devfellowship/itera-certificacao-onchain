// Hermetic web3 e2e guard (T14): the account files that solana-test-validator loads with --account.
//
//   node scripts/e2e/hermetic/setup-chain.mjs --hot-signer <keypair.json> --out <dir> [--source-rpc <url>]
//
// The API and apps/web/src/verify.ts pin the TestMyAgent SAS Credential and the run-result-v2 Schema
// (apps/api/src/chain/config.ts). This script reads those two accounts and the schema's group mint
// from a source cluster (default: public devnet, read only, no key), and APPENDS the job's own
// generated hot signer to the Credential's authorized signers. The authority and the name stay
// the same, so every address (credential PDA, schema PDA, schema mint, attestation PDA) is the
// production one. The patched copy exists only on the local validator of the job.
// The SAS program itself is cloned by the validator (--clone-upgradeable-program).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findSchemaMintPda, getCredentialDecoder, getCredentialEncoder } from '@solana/attestation';
import { createKeyPairSignerFromBytes } from '@solana/kit';

export const CREDENTIAL_PDA = 'Dh9NF2L2Ua2u4TUzKRX5u8S5DDCBLNA7aVkunteXt7A3';
export const RUN_RESULT_SCHEMA_PDA = '3FGWK6AsxtXje8r4Eq3rq3GPdoRd3ifx5UN9oKm4w94x';

const { values: argv } = parseArgs({
  options: {
    'hot-signer': { type: 'string' },
    out: { type: 'string' },
    'source-rpc': { type: 'string', default: 'https://api.devnet.solana.com' },
  },
});
if (!argv['hot-signer'] || !argv.out) {
  console.error('usage: setup-chain.mjs --hot-signer <keypair.json> --out <dir> [--source-rpc <url>]');
  process.exit(2);
}

const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(argv['hot-signer'], 'utf8'))));

async function getAccount(address) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(argv['source-rpc'], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const v = body.result?.value;
      if (!v) throw new Error(`account ${address} not found on ${argv['source-rpc']}`);
      return v;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

/** The JSON shape of `solana account --output json`, which `solana-test-validator --account` reads. */
function accountFile(pubkey, info, data) {
  return {
    pubkey,
    account: {
      // Enough for rent exemption at any size this script writes.
      lamports: Math.max(Number(info.lamports), 1_000_000_000),
      data: [Buffer.from(data).toString('base64'), 'base64'],
      owner: info.owner,
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
}

mkdirSync(argv.out, { recursive: true });

const credInfo = await getAccount(CREDENTIAL_PDA);
const credential = getCredentialDecoder().decode(Buffer.from(credInfo.data[0], 'base64'));
const signers = [...credential.authorizedSigners.filter((s) => s !== signer.address), signer.address];
const credData = getCredentialEncoder().encode({ ...credential, authorizedSigners: signers });
writeFileSync(join(argv.out, 'credential.json'), JSON.stringify(accountFile(CREDENTIAL_PDA, credInfo, credData)));

const schemaInfo = await getAccount(RUN_RESULT_SCHEMA_PDA);
writeFileSync(join(argv.out, 'schema.json'), JSON.stringify(accountFile(RUN_RESULT_SCHEMA_PDA, schemaInfo, Buffer.from(schemaInfo.data[0], 'base64'))));

const [schemaMint] = await findSchemaMintPda({ schema: RUN_RESULT_SCHEMA_PDA });
const mintInfo = await getAccount(schemaMint);
writeFileSync(join(argv.out, 'schema-mint.json'), JSON.stringify(accountFile(schemaMint, mintInfo, Buffer.from(mintInfo.data[0], 'base64'))));

console.log(JSON.stringify({ credential: CREDENTIAL_PDA, schema: RUN_RESULT_SCHEMA_PDA, schemaMint, hotSigner: signer.address, authorizedSigners: signers.length }));
