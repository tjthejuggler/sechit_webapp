// Builds vendor/ browser bundles for the static (GitHub Pages) build:
//   peerjs.min.js  — PeerJS client (from node_modules, pinned by package.json)
//   jsQR.js        — QR camera scanning (from node_modules)
//   qrcode.min.js  — QR code *rendering*: esbuild bundles the qrcode npm
//                    package's browser entry (CommonJS) into a standalone
//                    IIFE exposing window.QRCode — fully self-hosted, no CDN.
//
// Run automatically by the GitHub Pages workflow; run manually after
// `npm ci` / `npm install` when serving the repo-root site statically.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'vendor');
const nm = (...p) => path.join(root, 'node_modules', ...p);

await mkdir(outDir, { recursive: true });
await cp(nm('peerjs', 'dist', 'peerjs.min.js'), path.join(outDir, 'peerjs.min.js'));
await cp(nm('jsqr', 'dist', 'jsQR.js'), path.join(outDir, 'jsQR.js'));

// Standalone browser bundle of the qrcode package (QRCode.toCanvas/toDataURL).
await build({
  entryPoints: [nm('qrcode', 'lib', 'browser.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'QRCode',
  target: ['es2020'],
  outfile: path.join(outDir, 'qrcode.min.js'),
  // pngjs/yargs are Node-only paths the browser entry never touches; mark
  // them external-but-empty instead of bundling their shims.
  external: [],
  banner: {
    js: '/*! qrcode (MIT) — vendored bundle of the npm `qrcode` package */',
  },
  logLevel: 'info',
});

console.log('vendor bundles written to vendor/');
