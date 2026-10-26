import { createIcons, icons } from 'https://cdn.jsdelivr.net/npm/lucide@latest/+esm';

const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'contentflow_history';
let history = [];
let generating = false;

const refreshIcons = () => createIcons({ icons });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.opacity = '0'), 1800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Copied to clipboard');
}

/* ---------------- Auth ---------------- */
async function init() {
  refreshIcons();
  $('signInBtn').addEventListener('click', signIn);
  $('genForm').addEventListener('submit', onGenerate);
  $('clearHistory').addEventListener('click', clearHistory);
  $('topic').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('genForm').requestSubmit(); }
  });
  await render();
}

async function signIn() {
  try {
    await puter.auth.signIn();
    await render();
  } catch (e) {
    toast('Sign-in was cancelled');
  }
}

async function signOut() {
  puter.auth.signOut();
  history = [];
  $('results').innerHTML = '';
  await render();
}

async function render() {
  $('bootView').classList.add('hidden');
  const signedIn = puter.auth.isSignedIn();
  $('signedOutView').classList.toggle('hidden', signedIn);
  $('dashboardView').classList.toggle('hidden', !signedIn);
  const area = $('userArea');

  if (!signedIn) {
    area.innerHTML = `<button id="headerSignIn" class="text-sm font-medium px-3.5 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 transition">Sign in</button>`;
    $('headerSignIn').onclick = signIn;
    return;
  }

  let username = 'Account';
  try { const u = await puter.auth.getUser(); username = u.username; } catch {}
  area.innerHTML = `
    <div class="hidden sm:flex items-center gap-2 text-sm text-slate-600 mr-1">
      <span class="w-7 h-7 rounded-full bg-brand-100 text-brand-700 grid place-items-center text-xs font-semibold">${esc(username[0]?.toUpperCase() || 'U')}</span>
      ${esc(username)}
    </div>
    <button id="signOutBtn" class="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100 transition"><i data-lucide="log-out" class="w-4 h-4"></i><span class="hidden sm:inline">Sign out</span></button>`;
  $('signOutBtn').onclick = signOut;
  refreshIcons();
  await loadHistory();
  if (!$('results').innerHTML) renderEmpty();
}

/* ---------------- History ---------------- */
async function loadHistory() {
  try {
    const data = await puter.kv.get(HISTORY_KEY);
    history = Array.isArray(data) ? data : (data ? JSON.parse(data) : []);
  } catch { history = []; }
  renderHistory();
}

async function saveHistory() {
  try { await puter.kv.set(HISTORY_KEY, history); } catch {}
}

function renderHistory() {
  const list = $('historyList');
  $('clearHistory').classList.toggle('hidden', history.length === 0);
  if (!history.length) {
    list.innerHTML = `<li class="text-sm text-slate-400 py-2">Your generated content will appear here.</li>`;
    return;
  }
  list.innerHTML = history.map((h, i) => `
    <li>
      <button data-i="${i}" class="hist-item w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-50 transition">
        <p class="text-sm font-medium text-slate-800 truncate">${esc(h.topic)}</p>
        <p class="text-xs text-slate-400 mt-0.5">${new Date(h.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${esc(h.tone)}</p>
      </button>
    </li>`).join('');
  list.querySelectorAll('.hist-item').forEach((b) => b.addEventListener('click', () => {
    const h = history[+b.dataset.i];
    $('topic').value = h.topic;
    renderResults(h.data, h.topic);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}

async function clearHistory() {
  history = [];
  renderHistory();
  await saveHistory();
  toast('History cleared');
}

/* ---------------- Generation ---------------- */
function buildPrompt(topic, tone, audience) {
  return `You are an expert YouTube strategist and copywriter. Create a complete content package for a YouTube video.

Video topic: "${topic}"
Tone: ${tone}
Target audience: ${audience || 'general YouTube viewers'}

Respond ONLY with valid minified JSON (no markdown, no code fences, no commentary) using exactly this structure:
{
 "titles": ["5 distinct, click-worthy titles under 70 characters"],
 "description": "A YouTube description of 150-250 words with a strong first two lines, a short summary of what viewers will learn, a call to action to like/subscribe, and 3-5 relevant hashtags at the end. Use \\n for line breaks.",
 "thumbnails": [{"concept": "visual description of the thumbnail: subject, expression, background, colors, composition", "text": "2-5 word bold thumbnail text"}],
 "hook": "A powerful 20-40 second spoken intro hook script that grabs attention in the first 5 seconds.",
 "outline": [{"section": "section title", "points": ["key point", "key point"]}],
 "tags": ["15-20 relevant keywords/tags"]
}
Provide exactly 5 titles, exactly 3 thumbnails, and an outline of 5-7 sections (including intro and outro).`;
}

function extractText(resp) {
  if (typeof resp === 'string') return resp;
  const c = resp?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => p.text || '').join('');
  return resp?.text || String(resp ?? '');
}

function parseJSON(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found');
  return JSON.parse(t.slice(start, end + 1));
}

function normalize(d) {
  return {
    titles: Array.isArray(d.titles) ? d.titles.slice(0, 5).map(String) : [],
    description: String(d.description || ''),
    thumbnails: Array.isArray(d.thumbnails) ? d.thumbnails.slice(0, 3).map((t) => ({ concept: String(t.concept || t.idea || ''), text: String(t.text || t.thumbnail_text || '') })) : [],
    hook: String(d.hook || ''),
    outline: Array.isArray(d.outline) ? d.outline.map((s) => typeof s === 'string' ? { section: s, points: [] } : { section: String(s.section || s.title || ''), points: Array.isArray(s.points) ? s.points.map(String) : [] }) : [],
    tags: Array.isArray(d.tags) ? d.tags.map((t) => String(t).replace(/^#/, '')) : [],
  };
}

async function onGenerate(e) {
  e.preventDefault();
  if (generating) return;
  const topic = $('topic').value.trim();
  const tone = $('tone').value;
  const audience = $('audience').value.trim();
  $('formError').textContent = '';
  if (!topic) { $('formError').textContent = 'Please enter a video topic.'; $('topic').focus(); return; }
  if (!puter.auth.isSignedIn()) { await signIn(); if (!puter.auth.isSignedIn()) return; }

  setLoading(true);
  renderSkeleton();
  try {
    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await puter.ai.chat(buildPrompt(topic, tone, audience));
      try { data = normalize(parseJSON(extractText(resp))); break; }
      catch (err) { if (attempt === 1) throw new Error('The AI returned an unexpected format. Please try again.'); }
    }
    renderResults(data, topic);
    history.unshift({ topic, tone, at: Date.now(), data });
    history = history.slice(0, 15);
    renderHistory();
    saveHistory();
  } catch (err) {
    console.warn(err);
    $('results').innerHTML = `
      <div class="fade-in bg-white border border-red-200 rounded-2xl p-6 flex items-start gap-3">
        <i data-lucide="alert-circle" class="w-5 h-5 text-red-500 shrink-0 mt-0.5"></i>
        <div><p class="font-medium text-slate-800">Couldn't generate content</p>
        <p class="text-sm text-slate-500 mt-1">${esc(err?.message || err?.error?.message || 'Something went wrong. Please try again.')}</p></div>
      </div>`;
    refreshIcons();
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  generating = on;
  const b = $('generateBtn');
  b.disabled = on;
  b.innerHTML = on
    ? `<i data-lucide="loader-2" class="w-4 h-4 spin"></i><span>Generating…</span>`
    : `<i data-lucide="sparkles" class="w-4 h-4"></i><span>Generate Content</span>`;
  refreshIcons();
}

/* ---------------- Rendering ---------------- */
function renderEmpty() {
  $('results').innerHTML = `
    <div class="border border-dashed border-slate-300 rounded-2xl py-16 px-6 text-center">
      <div class="w-11 h-11 rounded-xl bg-brand-50 text-brand-600 grid place-items-center mx-auto"><i data-lucide="wand-2" class="w-5 h-5"></i></div>
      <p class="mt-4 font-medium text-slate-800">Ready when you are</p>
      <p class="text-sm text-slate-500 mt-1">Enter a topic above and click Generate Content.</p>
      <div class="mt-5 flex flex-wrap justify-center gap-2" id="examples">
        ${['Budget travel tips for Japan', 'Beginner home workout routine', 'iPhone vs Android in 2025'].map((x) =>
          `<button class="ex text-xs px-3 py-1.5 rounded-full border border-slate-200 bg-white hover:border-brand-500 hover:text-brand-700 transition">${x}</button>`).join('')}
      </div>
    </div>`;
  document.querySelectorAll('#examples .ex').forEach((b) => b.onclick = () => { $('topic').value = b.textContent; $('topic').focus(); });
  refreshIcons();
}

function renderSkeleton() {
  const block = (h) => `<div class="bg-white border border-slate-200 rounded-2xl p-5"><div class="skeleton h-4 w-32 mb-4"></div>${Array.from({ length: h }, (_, i) => `<div class="skeleton h-3 mb-2.5" style="width:${90 - i * 9}%"></div>`).join('')}</div>`;
  $('results').innerHTML = `<div class="space-y-4">${block(5)}<div class="grid md:grid-cols-2 gap-4">${block(4)}${block(4)}</div>${block(3)}</div>`;
}

const card = (icon, title, copyText, body, extra = '') => `
  <div class="fade-in bg-white border border-slate-200 rounded-2xl p-5 ${extra}">
    <div class="flex items-center justify-between mb-4">
      <h3 class="flex items-center gap-2 font-semibold text-[15px]"><span class="w-7 h-7 rounded-lg bg-brand-50 text-brand-600 grid place-items-center"><i data-lucide="${icon}" class="w-4 h-4"></i></span>${title}</h3>
      <button class="copy-btn inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-brand-700 px-2.5 py-1.5 rounded-lg hover:bg-slate-50 transition" data-copy="${esc(copyText)}"><i data-lucide="copy" class="w-3.5 h-3.5"></i>Copy</button>
    </div>${body}
  </div>`;

function renderResults(d, topic) {
  const titlesBody = `<ol class="space-y-2">${d.titles.map((t, i) => `
    <li class="group flex items-center gap-3 px-3 py-2.5 rounded-xl border border-slate-100 hover:border-slate-200 hover:bg-slate-50 transition">
      <span class="w-6 h-6 shrink-0 rounded-md bg-slate-100 text-slate-500 grid place-items-center text-xs font-semibold">${i + 1}</span>
      <span class="flex-1 text-sm text-slate-800">${esc(t)}</span>
      <span class="text-[11px] text-slate-400 hidden sm:inline">${t.length} chars</span>
      <button class="copy-btn opacity-60 group-hover:opacity-100 text-slate-400 hover:text-brand-700" data-copy="${esc(t)}" title="Copy"><i data-lucide="copy" class="w-3.5 h-3.5"></i></button>
    </li>`).join('')}</ol>`;

  const descBody = `<p class="text-sm text-slate-700 leading-relaxed whitespace-pre-line">${esc(d.description)}</p>`;

  const hookBody = `<blockquote class="text-sm text-slate-700 leading-relaxed border-l-2 border-brand-500 pl-4 italic">${esc(d.hook)}</blockquote>`;

  const thumbsBody = `<div class="grid sm:grid-cols-3 gap-3">${d.thumbnails.map((t, i) => `
    <div class="rounded-xl border border-slate-200 overflow-hidden">
      <div class="aspect-video bg-slate-900 grid place-items-center p-3 relative">
        <span class="absolute top-2 left-2 text-[10px] font-medium text-slate-400">Idea ${i + 1}</span>
        <p class="text-center font-extrabold uppercase text-white text-base leading-tight tracking-tight">${esc(t.text)}</p>
      </div>
      <p class="p-3 text-xs text-slate-600 leading-relaxed">${esc(t.concept)}</p>
    </div>`).join('')}</div>`;

  const outlineBody = `<ol class="space-y-3">${d.outline.map((s, i) => `
    <li class="flex gap-3">
      <span class="w-6 h-6 shrink-0 rounded-full border border-slate-200 text-slate-500 grid place-items-center text-xs font-semibold">${i + 1}</span>
      <div class="min-w-0"><p class="text-sm font-medium text-slate-800">${esc(s.section)}</p>
        ${s.points.length ? `<ul class="mt-1 space-y-0.5">${s.points.map((p) => `<li class="text-sm text-slate-500 flex gap-2"><span class="text-slate-300">–</span>${esc(p)}</li>`).join('')}</ul>` : ''}
      </div>
    </li>`).join('')}</ol>`;

  const tagsBody = `<div class="flex flex-wrap gap-2">${d.tags.map((t) => `<span class="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-700">${esc(t)}</span>`).join('')}</div>`;

  const allText = [
    `TOPIC: ${topic}`, '', 'TITLES:', ...d.titles.map((t, i) => `${i + 1}. ${t}`), '',
    'DESCRIPTION:', d.description, '',
    'THUMBNAIL IDEAS:', ...d.thumbnails.map((t, i) => `${i + 1}. "${t.text}" — ${t.concept}`), '',
    'HOOK:', d.hook, '',
    'OUTLINE:', ...d.outline.map((s, i) => `${i + 1}. ${s.section}${s.points.map((p) => `\n   - ${p}`).join('')}`), '',
    'TAGS:', d.tags.join(', '),
  ].join('\n');

  $('results').innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div class="min-w-0"><p class="text-xs font-medium text-slate-400 uppercase tracking-wide">Content package</p>
      <h2 class="font-semibold text-slate-900 truncate">${esc(topic)}</h2></div>
      <div class="flex gap-2">
        <button id="copyAll" class="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 transition"><i data-lucide="clipboard-copy" class="w-4 h-4"></i>Copy all</button>
        <button id="downloadAll" class="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 transition"><i data-lucide="download" class="w-4 h-4"></i><span class="hidden sm:inline">Download</span></button>
      </div>
    </div>
    <div class="space-y-4">
      ${card('type', 'YouTube titles', d.titles.join('\n'), titlesBody)}
      <div class="grid md:grid-cols-2 gap-4">
        ${card('zap', 'Intro hook', d.hook, hookBody)}
        ${card('file-text', 'Description', d.description, descBody)}
      </div>
      ${card('image', 'Thumbnail ideas', d.thumbnails.map((t, i) => `${i + 1}. "${t.text}" — ${t.concept}`).join('\n'), thumbsBody)}
      <div class="grid md:grid-cols-2 gap-4">
        ${card('list-ordered', 'Video outline', d.outline.map((s, i) => `${i + 1}. ${s.section}${s.points.map((p) => `\n   - ${p}`).join('')}`).join('\n'), outlineBody)}
        ${card('hash', 'Keywords & tags', d.tags.join(', '), tagsBody)}
      </div>
    </div>`;

  $('results').querySelectorAll('.copy-btn').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
  $('copyAll').onclick = () => copy(allText);
  $('downloadAll').onclick = () => {
    const blob = new Blob([allText], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${topic.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'content'}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  refreshIcons();
}

init();
