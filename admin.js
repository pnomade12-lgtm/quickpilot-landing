// QuickPilot 랜딩 편집 모드
// 구조: 페이지 로드 시 content/*.md fetch + marked로 렌더. 편집 버튼 클릭 시
// PAT 인증 → EasyMDE 에디터 열림 → 저장 시 GitHub API로 commit.

const REPO_OWNER = 'pnomade12-lgtm';
const REPO_NAME = 'quickpilot-landing';
const REPO_BRANCH = 'master';
const ADMIN_LOGIN = 'pnomade12-lgtm';
const SECTIONS = ['hero', 'hero-sub', 'buildup', 'now', 'manifesto', 'vision', 'demo', 'cta'];

let currentEditing = null;  // { name, sha, easyMDE }

// ============ 마크다운 fetch + 렌더 ============
async function loadSection(name) {
  try {
    // cache-bust로 항상 최신 자료 박힘
    const r = await fetch(`content/${name}.md?t=${Date.now()}`);
    if (!r.ok) throw new Error('fetch fail');
    const md = await r.text();
    const html = marked.parse(md, { breaks: true });
    const el = document.querySelector(`[data-content="${name}"]`);
    if (el) el.innerHTML = html;
    return md;
  } catch (e) {
    console.warn(`loadSection ${name} fail`, e);
    const el = document.querySelector(`[data-content="${name}"]`);
    if (el) el.innerHTML = `<p style="color:#ff3b30">콘텐츠 로드 실패: ${name}</p>`;
    return null;
  }
}

async function loadAll() {
  await Promise.all(SECTIONS.map(loadSection));
}

// ============ PAT 인증 ============
function getPAT() {
  return localStorage.getItem('qp_gh_pat') || '';
}

function setPAT(t) {
  if (t) localStorage.setItem('qp_gh_pat', t);
  else localStorage.removeItem('qp_gh_pat');
}

async function verifyPAT(token) {
  const r = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return { ok: false, msg: `HTTP ${r.status}` };
  const u = await r.json();
  if (u.login !== ADMIN_LOGIN) return { ok: false, msg: `관리자 권한 없음 (${u.login})` };
  return { ok: true, login: u.login };
}

function showPATModal() {
  const body = document.getElementById('edit-body');
  document.getElementById('edit-title').textContent = 'GitHub 로그인 (1회만)';
  body.innerHTML = `
    <p class="help">
      편집은 디렉터 본인(<code>${ADMIN_LOGIN}</code>)만 가능합니다.
      GitHub Personal Access Token을 발급받아 한 번 입력하면 이 기기에선 영구 기억됩니다.
    </p>
    <p class="help">
      <a href="https://github.com/settings/tokens/new?scopes=repo&description=QuickPilot%20Landing%20Edit" target="_blank">
        ▸ Token 발급 페이지 열기 (repo 권한 체크 후 Generate token)
      </a>
    </p>
    <input type="password" class="input" id="pat-input" placeholder="ghp_..." autocomplete="off">
    <p class="status" id="pat-status"></p>
  `;
  document.getElementById('overlay').classList.add('on');
  // 저장 버튼이 PAT 검증으로 동작
  const saveBtn = document.querySelector('.btn-save');
  saveBtn.textContent = '로그인';
  saveBtn.onclick = async () => {
    const t = document.getElementById('pat-input').value.trim();
    const status = document.getElementById('pat-status');
    status.textContent = '검증 중…';
    status.className = 'status';
    const v = await verifyPAT(t);
    if (v.ok) {
      setPAT(t);
      status.textContent = `✓ 로그인 완료 (${v.login}). 편집 가능합니다.`;
      status.className = 'status ok';
      setTimeout(() => closeEdit(), 800);
    } else {
      status.textContent = `✗ 실패: ${v.msg}`;
      status.className = 'status err';
    }
  };
}

// ============ 편집 모드 ============
async function openEdit(name) {
  const pat = getPAT();
  if (!pat) { showPATModal(); return; }
  // 검증 한 번 더 (만료 체크)
  const v = await verifyPAT(pat);
  if (!v.ok) {
    alert(`인증 실패: ${v.msg}. 토큰 재입력 필요.`);
    setPAT('');
    showPATModal();
    return;
  }

  // 현재 콘텐츠 + sha 받음
  const apiR = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/content/${name}.md?ref=${REPO_BRANCH}`,
    { headers: { Authorization: `Bearer ${pat}` } }
  );
  if (!apiR.ok) { alert(`콘텐츠 fetch 실패: HTTP ${apiR.status}`); return; }
  const meta = await apiR.json();
  const content = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ''))));

  // 에디터 UI
  document.getElementById('edit-title').textContent = `편집 — content/${name}.md`;
  document.getElementById('edit-body').innerHTML = `<textarea id="md-area"></textarea><p class="status" id="save-status"></p>`;
  document.getElementById('overlay').classList.add('on');

  const easy = new EasyMDE({
    element: document.getElementById('md-area'),
    initialValue: content,
    spellChecker: false,
    autofocus: true,
    status: false,
    minHeight: '300px',
    toolbar: ['bold', 'italic', 'heading', '|', 'quote', 'unordered-list', 'ordered-list', '|', 'link', 'preview', '|', 'guide']
  });

  currentEditing = { name, sha: meta.sha, easyMDE: easy };

  const saveBtn = document.querySelector('.btn-save');
  saveBtn.textContent = '저장 + Push';
  saveBtn.onclick = saveEdit;
}

async function saveEdit() {
  if (!currentEditing) { closeEdit(); return; }
  const { name, sha, easyMDE } = currentEditing;
  const newContent = easyMDE.value();
  const pat = getPAT();
  const status = document.getElementById('save-status');
  status.textContent = 'GitHub에 push 중…';
  status.className = 'status';

  // utf-8 안전 base64
  const b64 = btoa(unescape(encodeURIComponent(newContent)));

  const r = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/content/${name}.md`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `편집: content/${name}.md (랜딩 편집 UI)`,
        content: b64,
        sha: sha,
        branch: REPO_BRANCH
      })
    }
  );

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    status.textContent = `✗ 실패: ${e.message || r.status}`;
    status.className = 'status err';
    return;
  }
  status.textContent = '✓ 저장 완료. 1~2분 후 GitHub Pages 반영됩니다.';
  status.className = 'status ok';

  // 페이지에도 즉시 반영 (cache 우회로 다시 fetch)
  await loadSection(name);
  setTimeout(() => closeEdit(), 1200);
}

function closeEdit() {
  document.getElementById('overlay').classList.remove('on');
  if (currentEditing?.easyMDE) {
    currentEditing.easyMDE.toTextArea();
  }
  currentEditing = null;
  // 저장 버튼 기본 onclick 복원
  document.querySelector('.btn-save').onclick = saveEdit;
}

// ============ 초기 부팅 ============
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  document.querySelectorAll('.edit-btn').forEach(b => {
    b.addEventListener('click', () => openEdit(b.dataset.edit));
  });
  document.getElementById('overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay') closeEdit();
  });
});
