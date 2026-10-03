import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// wasm-bindgen imports a module's exports, not the URL produced by esbuild's file loader.
// Build a real WebAssembly bridge while retaining separate, measurable binary assets.
export function wasmPlugin() {
  return {
    name: 'wasm-bindgen-bridge',
    setup(build) {
      build.onResolve({ filter: /\.wasm$/ }, args => ({
        path: resolve(args.resolveDir, args.path),
        namespace: args.namespace === 'wasm-bridge' ? 'wasm-binary' : 'wasm-bridge',
      }));
      build.onLoad({ filter: /.*/, namespace: 'wasm-binary' }, async args => ({
        contents: await readFile(args.path), loader: 'file',
      }));
      build.onLoad({ filter: /.*/, namespace: 'wasm-bridge' }, async args => {
        const module = new WebAssembly.Module(await readFile(args.path));
        const modules = [...new Set(WebAssembly.Module.imports(module).map(x => x.module))];
        const imports = modules.map((name, index) =>
          `import * as import${index} from ${JSON.stringify(resolve(dirname(args.path), name))};`);
        const importObject = modules.map((name, index) => `${JSON.stringify(name)}: import${index}`).join(',');
        const exports = WebAssembly.Module.exports(module).map(({ name }, index) =>
          `const exported${index} = instance.exports[${JSON.stringify(name)}]; export { exported${index} as ${name} };`);
        return { loader: 'js', resolveDir: dirname(args.path), contents: [
          `import url from ${JSON.stringify(args.path)};`, ...imports,
          `const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL(url, import.meta.url)), {${importObject}});`,
          ...exports,
        ].join('\n') };
      });
    },
  };
}
