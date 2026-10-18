import { readFile, readdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
async function walk(path) {
  for (const item of await readdir(new URL(path, root), { withFileTypes: true })) {
    const name = `${path}${item.name}`;
    if (item.isDirectory()) await walk(`${name}/`);
    else if (/\.(ts|mjs|js|css|html)$/.test(name)) {
      const source = await readFile(new URL(name, root), 'utf8');
      if (/[^\S\r\n]+$/m.test(source)) throw new Error(`Trailing whitespace: ${name}`);
      if (name.startsWith('apps/') || name.startsWith('packages/')) {
        if (/\b(?:from|import)\s*[^\n]*spikes\//.test(source))
          throw new Error(`Product imports disposable spike: ${name}`);
      }
    }
  }
}
for (const path of ['packages/', 'apps/', 'tools/', 'tests/']) await walk(path);
console.log('Source hygiene and product/spike boundary passed');
