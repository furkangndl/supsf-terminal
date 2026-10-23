// Record the repo location so a packaged app can find bin/supsf.js (read by main.cjs).
const fs = require('node:fs');
const path = require('node:path');

fs.writeFileSync(path.join(__dirname, '..', 'root.txt'), path.resolve(__dirname, '..', '..'));
