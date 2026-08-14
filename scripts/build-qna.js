// QnA100 마크다운 → HTML 빌드
// vault의 QnA_랜딩페이지.md를 읽어 qna100/index.html과 이미지 복사
const fs = require('fs');
const path = require('path');

const VAULT_MD = 'C:/Users/rlasn/Obsidian/04_전자책/QnA_랜딩페이지.md';
const VAULT_ROOT = 'C:/Users/rlasn/Obsidian';
const OUT_DIR = path.join(__dirname, '..', 'qna100');
const OUT_HTML = path.join(OUT_DIR, 'index.html');
const OUT_IMG = path.join(OUT_DIR, 'img');

function findImage(name) {
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
      } else if (e.name === name) {
        return p;
      }
    }
  }
  return null;
}

function copyImg(name) {
  const src = findImage(name);
  if (!src) { console.log('  [miss]', name); return false; }
  if (!fs.existsSync(OUT_IMG)) fs.mkdirSync(OUT_IMG, { recursive: true });
  fs.copyFileSync(src, path.join(OUT_IMG, name));
  console.log('  [copy]', name);
  return true;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFmt(s) {
  s = escapeHtml(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return s;
}

// 마크다운 본문 변환
function convert(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  const toc = []; // 목차 데이터: [{type, id, title, qnum?, range?}]
  let i = 0;

  // 헤더 메타 스킵 (첫 # title + 한두 줄 설명)
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('## ')) break;
    i++;
  }

  let currentSection = null; // 'prologue' | 'commandments' | 'cat'
  let currentCatId = null;
  let catIdx = 0;
  let inArticle = false;
  let inComments = false;
  let inList = false;

  function closeArticle() {
    if (inComments) { out.push('    </div>'); inComments = false; }
    if (inList) { out.push('    </ul>'); inList = false; }
    if (inArticle) { out.push('    <div class="to-top"><a href="#toc">↑ 목차로</a></div>'); out.push('  </article>'); inArticle = false; }
  }
  function closeSection() {
    closeArticle();
    if (currentSection === 'prologue') { out.push('</section>'); out.push('<!--TOC_PLACEHOLDER-->'); }
    else if (currentSection === 'commandments') { out.push('  </ol>'); out.push('</div>'); }
    else if (currentSection === 'cat') out.push('</section>');
    currentSection = null;
  }

  for (; i < lines.length; i++) {
    const l = lines[i];

    // 섹션 헤더
    const h2 = l.match(/^## (.+)$/);
    if (currentSection === 'skip' && !h2) continue;
    if (h2) {
      closeSection();
      const title = h2[1].trim();
      if (title.includes('프롤로그')) {
        currentSection = 'prologue';
        toc.push({ type: 'prologue', id: 'prologue', title });
        out.push('<section class="prologue" id="prologue">');
        out.push('  <h2>' + inlineFmt(title) + '</h2>');
      } else if (title.includes('십계명')) {
        // 보류 — 인터루드로 이전 예정. 사이트엔 표시 X.
        currentSection = 'skip';
      } else {
        currentSection = 'cat';
        catIdx++;
        currentCatId = 'cat-' + catIdx;
        const m = title.match(/^(.+?)\s*\(Q\.(\d+)\s*~\s*Q\.(\d+)\)\s*$/);
        const catTitle = m ? m[1].trim() : title;
        const catRange = m ? ('Q.' + m[2] + ' ~ Q.' + m[3]) : '';
        toc.push({ type: 'cat', id: currentCatId, title: catTitle, range: catRange, qs: [] });
        out.push('<section class="cat" id="' + currentCatId + '">');
        out.push('  <h2 class="cat-title">' + inlineFmt(catTitle) + '</h2>');
        if (catRange) out.push('  <div class="cat-range">' + catRange + '</div>');
      }
      continue;
    }

    // Q.XX 헤더
    const h3 = l.match(/^### (Q\.\d+)\s+(.+)$/);
    if (h3) {
      closeArticle();
      inArticle = true;
      const qid = 'q' + h3[1].replace(/[^0-9]/g, '').padStart(2, '0');
      // 현재 카테고리 토크 항목에 Q 추가
      const lastCat = [...toc].reverse().find(t => t.type === 'cat');
      if (lastCat) lastCat.qs.push({ qnum: h3[1], title: h3[2], id: qid });
      out.push('  <article class="qa" id="' + qid + '">');
      out.push('    <h3 class="q"><span class="qnum">' + h3[1] + '</span>' + inlineFmt(h3[2]) + '</h3>');
      continue;
    }

    // ✅ 답변 라벨
    if (/^\*\*✅\s*답변\*\*\s*$/.test(l)) {
      out.push('    <div class="ans-label">✅ 답변</div>');
      continue;
    }
    // 💬 댓글 라벨
    if (/^\*\*💬\s*다른 기사 의견\*\*\s*$/.test(l)) {
      if (inList) { out.push('    </ul>'); inList = false; }
      out.push('    <div class="comments">');
      out.push('      <div class="label">💬 다른 기사 의견</div>');
      inComments = true;
      continue;
    }
    // 📌 공유거래규정
    const regul = l.match(/^📌\s*\*\*(.+?)\*\*\s*—\s*(.+)$/);
    if (regul) {
      if (inComments) { out.push('    </div>'); inComments = false; }
      out.push('    <div class="regul"><span class="label">📌 ' + escapeHtml(regul[1]) + '</span>' + escapeHtml(regul[2]) + '</div>');
      continue;
    }

    // 댓글 라인
    const cmt = l.match(/^👤\s+(.+)$/);
    if (cmt) {
      out.push('      <div class="c"><span class="ico">👤</span><span>' + inlineFmt(cmt[1]) + '</span></div>');
      continue;
    }

    // 십계명 라인 — **제N계명** — 본문
    if (currentSection === 'commandments') {
      const cmd = l.match(/^\*\*제\d+계명\*\*\s*[—–-]\s*(.+)$/);
      if (cmd) {
        out.push('    <li>' + inlineFmt(cmd[1]) + '</li>');
        continue;
      }
    }

    // 리스트 아이템
    const ul = l.match(/^[-*]\s+(.+)$/);
    if (ul) {
      if (!inList) {
        if (inComments) { out.push('    </div>'); inComments = false; }
        out.push('    <ul>');
        inList = true;
      }
      out.push('      <li>' + inlineFmt(ul[1]) + '</li>');
      continue;
    }
    if (inList && !l.trim()) continue;
    if (inList && !ul) { out.push('    </ul>'); inList = false; }

    // 인용블록 (>)
    if (l.startsWith('> ')) {
      out.push('  <div class="note">' + inlineFmt(l.slice(2)) + '</div>');
      continue;
    }

    // wikilink 이미지
    const wikis = [...l.matchAll(/!\[\[([^\]]+?)\]\]/g)].map(m => m[1].split('|')[0]);
    if (wikis.length > 0) {
      wikis.forEach(copyImg);
      const tag = wikis.length > 1
        ? '<div class="img-row">' + wikis.map(n => '<img src="img/' + n + '" alt="">').join('') + '</div>'
        : '<img class="img-solo" src="img/' + wikis[0] + '" alt="">';
      out.push((inArticle ? '    ' : '  ') + tag);
      continue;
    }

    // 구분선
    if (/^---+$/.test(l.trim())) continue;

    // placeholder pending — "재검토 대상" 또는 "검토본 원문 기반"
    const pending = l.match(/^(Q\.\d+(?:\s*~\s*Q\.\d+)?)\s*[—–-]\s*(.+)$/);
    if (pending && (l.includes('재검토') || l.includes('검토본 원문 기반') || l.includes('순차 작업'))) {
      out.push('  <div class="pending"><span class="qnum">' + pending[1] + '</span>' + escapeHtml(pending[2]) + '</div>');
      continue;
    }

    // 일반 문단
    if (l.trim()) {
      const para = inlineFmt(l);
      if (inArticle) out.push('    <p>' + para + '</p>');
      else if (currentSection === 'prologue') out.push('  <p>' + para + '</p>');
      else if (currentSection === 'cat') out.push('  <p>' + para + '</p>');
      else out.push('<p>' + para + '</p>');
    }
  }

  closeSection();

  // 목차 HTML 생성
  const tocOut = ['<nav class="toc" id="toc">', '  <h2>📑 목차</h2>', '  <ul class="toc-top">'];
  for (const t of toc) {
    if (t.type === 'prologue' || t.type === 'commandments') {
      tocOut.push('    <li><a href="#' + t.id + '">' + escapeHtml(t.title) + '</a></li>');
    } else if (t.type === 'cat') {
      const rangeLabel = t.range ? ' <span class="toc-range">' + escapeHtml(t.range) + '</span>' : '';
      tocOut.push('    <li><a href="#' + t.id + '">' + escapeHtml(t.title) + '</a>' + rangeLabel);
      if (t.qs.length) {
        tocOut.push('      <ul class="toc-q">');
        for (const q of t.qs) {
          tocOut.push('        <li><a href="#' + q.id + '"><span class="qnum">' + q.qnum + '</span> ' + escapeHtml(q.title) + '</a></li>');
        }
        tocOut.push('      </ul>');
      }
      tocOut.push('    </li>');
    }
  }
  tocOut.push('  </ul>', '</nav>');

  const tocHtml = tocOut.join('\n');
  let body = out.join('\n');
  if (body.includes('<!--TOC_PLACEHOLDER-->')) {
    body = body.replace('<!--TOC_PLACEHOLDER-->', tocHtml);
    return body;
  }
  return tocHtml + '\n' + body;
}

function buildPage() {
  const md = fs.readFileSync(VAULT_MD, 'utf-8');
  const body = convert(md);
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>차량 퀵서비스 기사를 위한 100가지 문답</title>
<style>
  :root {
    --bg: #f6efde; --paper: #fdf9ef; --ink: #3a342a; --muted: #8a7f6a;
    --accent: #5a7355; --warn: #b85c3b; --rule: #d9cfb8;
    --comment-bg: #ece4cf; --regul-bg: #fff2d4;
    --pending: #ede5cf; --pending-ink: #a59a82;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--ink); margin: 0; padding: 0; }
  body {
    font-family: "SamsungOne","Samsung Sans","SamsungSharpSans","Galaxy Sans",-apple-system,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;
    font-size: 17px; line-height: 1.8; word-break: keep-all; overflow-wrap: break-word; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; }
  header.book-head { border-bottom: 1px solid var(--rule); padding-bottom: 24px; margin-bottom: 40px; }
  header.book-head h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.5px; color: var(--ink); }
  header.book-head .sub { color: var(--muted); font-size: 14px; }
  section.prologue { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 40px 32px; margin-bottom: 48px; }
  section.prologue h2 { text-align: center; font-size: 22px; margin: 0 0 32px; letter-spacing: 2px; color: var(--accent); }
  section.prologue p { margin: 0 0 18px; text-align: justify; }
  .commandments { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 32px 28px 14px; margin-bottom: 56px; }
  .commandments h2 { text-align: center; font-size: 20px; margin: 0 0 28px; letter-spacing: 1px; color: var(--accent); }
  .commandments ol { list-style: none; counter-reset: cmd; padding: 0; margin: 0; }
  .commandments li { counter-increment: cmd; padding: 16px 0; border-bottom: 1px dashed var(--rule); position: relative; padding-left: 64px; }
  .commandments li:last-child { border-bottom: none; }
  .commandments li::before { content: "제" counter(cmd) "계명"; position: absolute; left: 0; top: 16px; font-size: 12px; color: var(--warn); font-weight: 700; }
  section.cat { margin: 56px 0 32px; }
  section.cat h2.cat-title { font-size: 22px; margin: 0 0 6px; padding-bottom: 10px; border-bottom: 2px solid var(--accent); color: var(--ink); }
  section.cat .cat-range { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  article.qa { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 28px 28px 20px; margin-bottom: 28px; }
  article.qa h3.q { font-size: 18px; margin: 0 0 18px; line-height: 1.55; color: var(--ink); }
  article.qa h3.q .qnum { color: var(--accent); margin-right: 8px; font-weight: 700; }
  article.qa .ans-label { color: var(--accent); font-weight: 700; margin: 8px 0 14px; font-size: 15px; }
  article.qa p { margin: 0 0 14px; }
  article.qa ul { padding-left: 22px; margin: 8px 0 16px; }
  article.qa ul li { padding: 4px 0; }
  .img-solo { display: block; max-width: 100%; height: auto; margin: 28px auto; border-radius: 4px; }
  .img-row { display: flex; gap: 8px; margin: 28px 0; }
  .img-row img { flex: 1; min-width: 0; max-width: 50%; height: auto; border-radius: 4px; }
  .comments { background: var(--comment-bg); border-radius: 6px; padding: 18px 22px 8px; margin: 20px 0 12px; }
  .comments .label { font-size: 14px; color: var(--muted); font-weight: 700; margin-bottom: 10px; }
  .comments .c { display: flex; gap: 10px; margin: 0 0 12px; font-size: 16px; line-height: 1.7; }
  .regul { background: var(--regul-bg); border-left: 3px solid var(--warn); padding: 14px 16px; margin: 16px 0 8px; font-size: 14.5px; line-height: 1.7; border-radius: 4px; }
  .regul .label { font-weight: 700; color: var(--warn); margin-right: 6px; }
  .to-top { text-align: right; color: var(--muted); font-size: 13px; margin-top: 12px; }
  .pending { background: var(--pending); color: var(--pending-ink); border: 1px dashed #c4b893; padding: 16px 20px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
  .pending .qnum { color: var(--pending-ink); font-weight: 700; margin-right: 6px; }
  .note { background: #f3e9c8; border-left: 3px solid #c8a85a; padding: 14px 18px; margin: 12px 0 24px; font-size: 13.5px; color: #6e5a2a; border-radius: 4px; }
  footer.foot { margin-top: 80px; padding-top: 24px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 13px; text-align: center; }
  nav.toc { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 28px 28px 20px; margin-bottom: 48px; }
  nav.toc h2 { font-size: 18px; margin: 0 0 18px; color: var(--accent); letter-spacing: 1px; }
  nav.toc ul { list-style: none; padding: 0; margin: 0; }
  nav.toc .toc-top > li { padding: 8px 0; border-bottom: 1px dashed var(--rule); }
  nav.toc .toc-top > li:last-child { border-bottom: none; }
  nav.toc a { color: var(--ink); text-decoration: none; }
  nav.toc a:hover { color: var(--accent); }
  nav.toc .toc-range { color: var(--muted); font-size: 12px; margin-left: 6px; }
  nav.toc .toc-q { padding-left: 16px; margin-top: 6px; }
  nav.toc .toc-q li { padding: 4px 0; font-size: 14.5px; }
  nav.toc .toc-q .qnum { color: var(--accent); font-weight: 700; margin-right: 6px; }
  @media (max-width: 640px) {
    body { font-size: 15.5px; line-height: 1.75; }
    .wrap { padding: 24px 16px 60px; }
    header.book-head h1 { font-size: 22px; line-height: 1.4; }
    section.prologue { padding: 28px 20px; }
    .commandments { padding: 24px 18px 8px; }
    .commandments li { padding: 14px 0 14px 60px; font-size: 15px; }
    section.cat h2.cat-title { font-size: 19px; }
    article.qa { padding: 22px 18px 14px; }
    article.qa h3.q { font-size: 16.5px; }
  }
</style>
</head>
<body>
<div class="wrap">
<header class="book-head">
  <h1>차량 퀵서비스 기사를 위한 100가지 문답</h1>
  <div class="sub">검토용 미리보기 · 작업 중</div>
</header>
${body}
<footer class="foot">차량 퀵서비스 기사를 위한 100가지 문답 · 검토용 미리보기</footer>
</div>
</body>
</html>`;
  fs.writeFileSync(OUT_HTML, html, 'utf-8');
  console.log('[built]', OUT_HTML, '(' + html.length + ' bytes)');
}

if (require.main === module) {
  buildPage();
}
module.exports = { buildPage };
