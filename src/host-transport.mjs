import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const methods = new Set(['search_products', 'get_product', 'get_products', 'web_search', 'normalize_request']);

/** Local transport serviced by the authorized Codex host. Contains no credentials. */
export async function createHostTransport(directory) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  return {
    async invoke(method, args, { signal } = {}) {
      if (!methods.has(method)) throw new Error('Unsupported VI host method');
      signal?.throwIfAborted();
      const id = randomUUID();
      const pending = join(root, id + '.pending');
      await writeFile(pending, JSON.stringify({ id, method, args }), { flag: 'wx' });
      await rename(pending, join(root, id + '.request.json'));
      for (;;) {
        signal?.throwIfAborted();
        try {
          const response = JSON.parse(await readFile(join(root, id + '.response.json'), 'utf8'));
          if (response.id !== id) throw new Error('Host response ID mismatch');
          if (response.transportError) throw new Error('Host transport failed');
          return response.result;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await setTimeout(100, undefined, { signal });
      }
    },
    async persist(record) {
      const ref = join(root, 'evidence-' + randomUUID() + '.json');
      await writeFile(ref, JSON.stringify(record, null, 2), { flag: 'wx' });
      return ref;
    },
  };
}
