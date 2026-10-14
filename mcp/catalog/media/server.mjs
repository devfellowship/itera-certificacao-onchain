// media@1 — Itera's own stateful fake of a media host (ADR-8 of plan
// 20261012-testmyagent-dfl-benchmark-tasks: no open server fits, so a small fake in the shape of
// helpdesk). The bytes go to the sidecar tmpfs (/state/blobs/<id>); the metadata goes to
// /state/state.json. Ids are M-<ITERA_MCP_ID_SEED + n>, timestamps come from the fixed clock, so
// the same seed plus the same calls gives the same export byte for byte.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '/itera/fixture.mjs';

export const STATE_FILE = 'state.json';
export const BASE_URL = 'https://media.fixture.test';
/** Total bytes the store holds. The tmpfs is 64 MB; this keeps far below it. */
export const MAX_STORE_BYTES = 16 * 1024 * 1024;

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** `text/html; charset=utf-8` -> `text/html`. */
export const mediaType = (contentType) => contentType.split(';')[0].trim().toLowerCase();

/** Strict base64 decode: whitespace is ignored, anything else that is not base64 is an error. */
export function decodeBase64(raw) {
  const clean = raw.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('content_base64 is not valid base64');
  return Buffer.from(clean, 'base64');
}

export function createMedia() {
  let state;
  let stateDir;
  let idSeed = 1000;
  const persist = () => {
    const tmp = join(stateDir, `${STATE_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, join(stateDir, STATE_FILE));
  };
  const blobPath = (id) => join(stateDir, 'blobs', id);
  const meta = (f) => {
    const { deleted_at, ...rest } = f;
    return deleted_at ? { ...rest, deleted_at } : rest;
  };
  const storedBytes = () => state.files.filter((f) => !f.deleted_at).reduce((n, f) => n + f.size, 0);
  const store = (id, bytes, fields) => {
    writeFileSync(blobPath(id), bytes);
    const file = {
      id,
      filename: fields.filename,
      url: `${BASE_URL}/${id}`,
      sha256: sha256(bytes),
      size: bytes.length,
      content_type: fields.content_type.trim(),
      media_type: mediaType(fields.content_type),
      visibility: fields.visibility,
      created_at: fields.created_at,
      seeded: fields.seeded,
    };
    state.files.push(file);
    return file;
  };

  return {
    get state() {
      return state;
    },
    async init({ seed, stateDir: dir, clock, idSeed: ids }) {
      stateDir = dir;
      idSeed = ids;
      mkdirSync(join(stateDir, 'blobs'), { recursive: true });
      state = { files: [], next: 1 };
      const seen = new Set();
      for (const f of seed.files) {
        if (seen.has(f.id)) throw new Error(`duplicate seed file id ${f.id}`);
        seen.add(f.id);
        store(f.id, Buffer.from(f.content, 'utf-8'), { ...f, created_at: f.created_at ?? clock(0), seeded: true });
      }
      persist();
    },
    async call(name, args, ctx) {
      switch (name) {
        case 'upload_file': {
          let bytes;
          if (typeof args.content === 'string') bytes = Buffer.from(args.content, 'utf-8');
          else {
            try {
              bytes = decodeBase64(args.content_base64);
            } catch (err) {
              return fail(err.message);
            }
          }
          if (bytes.length === 0) return fail('the file is empty');
          if (storedBytes() + bytes.length > MAX_STORE_BYTES) return fail(`the store is full (limit ${MAX_STORE_BYTES} bytes)`);
          // A new id even when an earlier id was seeded or deleted: never reuse one.
          let id;
          do {
            id = `M-${idSeed + state.next}`;
            state.next += 1;
          } while (state.files.some((f) => f.id === id));
          const file = store(id, bytes, { ...args, created_at: ctx.clock(), seeded: false });
          persist();
          return text(meta(file));
        }
        case 'get_file_meta': {
          const f = state.files.find((x) => x.id === args.id);
          return f ? text(meta(f)) : fail(`file ${args.id} not found`);
        }
        case 'delete_file': {
          const f = state.files.find((x) => x.id === args.id);
          if (!f) return fail(`file ${args.id} not found`);
          if (f.deleted_at) return fail(`file ${f.id} is already deleted`);
          f.deleted_at = ctx.clock();
          rmSync(blobPath(f.id), { force: true });
          persist();
          return text({ id: f.id, deleted: true, deleted_at: f.deleted_at });
        }
        default:
          return fail(`unknown tool ${name}`);
      }
    },
  };
}

if (process.argv[1] === import.meta.filename) {
  await serve(createMedia());
}
