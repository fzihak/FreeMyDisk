const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targetReleaseDir = path.join(rootDir, 'target', 'release');
const targetDebugDir = path.join(rootDir, 'target', 'debug');
const resourcesDir = path.join(rootDir, 'src-tauri', 'resources');

if (!fs.existsSync(resourcesDir)) {
  fs.mkdirSync(resourcesDir, { recursive: true });
}

const binaries = ['freemydisk-elevated.exe', 'freemydisk-cli.exe'];

for (const bin of binaries) {
  let src = path.join(targetReleaseDir, bin);
  if (!fs.existsSync(src)) {
    src = path.join(targetDebugDir, bin);
  }

  if (fs.existsSync(src)) {
    const dest = path.join(resourcesDir, bin);
    fs.copyFileSync(src, dest);
    console.log(`[sync-helpers] Copied ${src} -> ${dest}`);
  } else {
    console.warn(`[sync-helpers] Warning: ${bin} not found in release or debug target dirs.`);
  }
}
