// vault QnA_랜딩페이지.md + 이미지 변경 감지 → 빌드 + Firebase deploy
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { buildPage } = require('./build-qna');

const VAULT_MD = 'C:/Users/rlasn/Obsidian/04_전자책/QnA_랜딩페이지.md';
const VAULT_ROOT = 'C:/Users/rlasn/Obsidian';
const PROJECT_DIR = path.join(__dirname, '..');
const POLL_MS = 30 * 1000;

let lastHash = '';
let busy = false;

function hashState() {
  // md mtime + vault 내 모든 이미지 mtime을 한 줄 키로
  let parts = [];
  try { parts.push('md:' + fs.statSync(VAULT_MD).mtimeMs); } catch { parts.push('md:0'); }

  const stack = [VAULT_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        stack.push(p);
      } else if (/\.(png|jpe?g|webp|gif)$/i.test(e.name)) {
        try {
          const s = fs.statSync(p);
          parts.push(e.name + ':' + s.mtimeMs + ':' + s.size);
        } catch {}
      }
    }
  }
  return parts.join('|');
}

function deploy() {
  console.log('[deploy] firebase deploy --only hosting');
  try {
    execSync('firebase deploy --only hosting', {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      windowsHide: true,
    });
    console.log('[deploy] complete');
  } catch (e) {
    console.error('[deploy] failed:', e.message);
  }
}

function tick() {
  if (busy) return;
  const h = hashState();
  if (h === lastHash) return;
  busy = true;
  const prev = lastHash;
  lastHash = h;
  console.log(new Date().toISOString(), '[change detected]');
  try {
    buildPage();
    deploy();
  } catch (e) {
    console.error('[error]', e.message);
    lastHash = prev; // 실패 시 다음 tick에 재시도
  } finally {
    busy = false;
  }
}

console.log('[watch] start. polling every', POLL_MS / 1000, 's');
console.log('[watch] vault md:', VAULT_MD);
lastHash = hashState();
console.log('[watch] initial state captured. waiting for changes...');
setInterval(tick, POLL_MS);
