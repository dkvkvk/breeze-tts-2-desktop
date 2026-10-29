'use strict';
/* 把 src/ui 与 assets/icon.ico 同步到 shell/ 下，保证前端只有一份源。 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copies = [
  [path.join(root, 'src', 'ui'), path.join(__dirname, 'ui')],
  [path.join(root, 'assets', 'icon.ico'), path.join(__dirname, 'assets', 'icon.ico')]
];

for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.statSync(from).isDirectory()) {
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      fs.copyFileSync(path.join(from, f), path.join(to, f));
    }
    console.log('ui  -> ' + to + '  (' + fs.readdirSync(to).length + ' 个文件)');
  } else {
    fs.copyFileSync(from, to);
    console.log('ico -> ' + to);
  }
}
