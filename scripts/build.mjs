import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
const source = new URL('../outputs/', import.meta.url);
const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error('Defina SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY antes de compilar.');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
const logoBase64 = (await readFile(new URL('../assets/nexus-logo-original.jpeg.b64', import.meta.url), 'utf8')).trim();
await writeFile(new URL('nexus-logo-original.jpeg', output), Buffer.from(logoBase64, 'base64'));
await writeFile(new URL('nexus-config.js', output),
  `window.NEXUS_CONFIG = ${JSON.stringify({ url, publishableKey })};\n`, 'utf8');

