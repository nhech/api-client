// Renders site/favicon.svg to site/icon.png (256 x 256, transparent corners) with a local Chromium-based browser in headless mode.
// scripts/build-site.cjs box-filters the 32 pixel favicon from this file and copies it as the touch icon.
// No dependencies. Usage: node scripts/render-icon.cjs
// OG_BROWSER overrides the browser executable, as for scripts/render-og.cjs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const SIZE = 256;
const root = path.resolve(__dirname, '..');
const svg = path.join(root, 'site', 'favicon.svg');
const output = path.join(root, 'site', 'icon.png');
const candidates = [
  process.env.OG_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);
const browser = candidates.find(file => fs.existsSync(file));
if (!browser) throw new Error('No Chromium-based browser found. Set OG_BROWSER to its executable.');

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const profile = fs.mkdtempSync(path.join(process.env.OG_PROFILE_DIR || os.tmpdir(), 'api-client-icon-'));
const page = path.join(profile, 'icon.html');
const shot = path.join(profile, 'icon.png');
fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block}</style><img src="${pathToFileURL(svg).href}" width="${SIZE}" height="${SIZE}" alt="">`);
try {
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--default-background-color=00000000',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profile}`,
    `--window-size=${SIZE},${SIZE}`, '--virtual-time-budget=2000', `--screenshot=${shot}`, pathToFileURL(page).href
  ], { stdio: 'inherit', timeout: 60000 });
  // Some launchers return before the headless child has written the file: wait until its size is stable.
  let size = -1;
  for (let waited = 0; waited < 30000; waited += 250) {
    const current = fs.existsSync(shot) ? fs.statSync(shot).size : -1;
    if (current > 0 && current === size) break;
    size = current;
    sleep(250);
  }
  if (size <= 0) throw new Error('The browser did not write a screenshot.');
  fs.copyFileSync(shot, output);
} finally {
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  catch { console.warn(`Could not remove the temporary browser profile ${profile}; delete it manually.`); }
}

const png = fs.readFileSync(output);
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!png.subarray(0, 8).equals(signature)) throw new Error('site/icon.png is not a PNG.');
const width = png.readUInt32BE(16), height = png.readUInt32BE(20), colorType = png[25];
if (width !== SIZE || height !== SIZE) throw new Error(`site/icon.png must be ${SIZE}x${SIZE}, got ${width}x${height}.`);
if (colorType !== 6) throw new Error(`site/icon.png must be RGBA (colour type 6), got colour type ${colorType}.`);
console.log(JSON.stringify({ output: 'site/icon.png', width, height, bytes: png.length }));
