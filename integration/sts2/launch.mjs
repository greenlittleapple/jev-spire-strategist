import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try { process.loadEnvFile(resolve(root, '.env')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!process.env.TYPESAFE_API_KEY) throw Error('Add TYPESAFE_API_KEY to the project .env file.');
if (process.env.SPIRE_ADVISER) throw Error('This setup uses Jev only. Remove SPIRE_ADVISER to continue.');
process.env.SPIRE_LOG_DIR = resolve(root, '.private/sts2/runs');
process.env.MAX_DECISIONS ??= '2000';
process.env.MAX_INPUT_TOKENS ??= '30000000';
await mkdir(process.env.SPIRE_LOG_DIR, { recursive: true });
await import('../../vendor/jev-the-spire/spire-demo/server.mjs');
