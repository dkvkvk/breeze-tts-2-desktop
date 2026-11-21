'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');

async function bundle() {
  const result = await build({
    absWorkingDir: __dirname,
    entryPoints: ['./mcp.cjs'],
    outfile: './agent/voicetrack-mcp.cjs',
    bundle: true,
    platform: 'node',
    target: 'node22',
    legalComments: 'eof',
    metafile: true
  });
  const directories = new Set();
  for (const name of Object.keys(result.metafile.inputs)) {
    const match = name.match(/^(.+?\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+)|node_modules\/(?:@[^/]+\/[^/]+|[^/]+))\//);
    if (match) directories.add(match[1]);
  }
  const notices = [];
  for (const relative of [...directories].sort()) {
    const directory = path.resolve(__dirname, relative);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const license = fs.readdirSync(directory).find(file => /^(license|licence|copying)(\.(md|txt))?$/i.test(file));
    const header = manifest.name + ' ' + manifest.version + ' (' + manifest.license + ')';
    notices.push(header + '\n\n' + (license ? fs.readFileSync(path.join(directory, license), 'utf8').trim() : manifest.license));
  }
  fs.writeFileSync(path.join(__dirname, 'agent', 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n-----\n\n') + '\n');
}

bundle().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
