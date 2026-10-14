'use strict';

/* ===================== 常量 ===================== */
const STORAGE_KEY = 'englishApp.v1';
const API_URL = 'https://api.anthropic.com/v1/messages';

// 工作日的场景主题（周日=0 … 周六=6）
const WORK_THEMES = {
  0: '综合工作场景：写一段本周工作总结或下周计划（英文邮件/更新）',
  1: '写一封催促业主确认技术文件的邮件',
  2: '写一段解释设备延迟原因的话术',
  3: '写一段拒绝业主变更要求的委婉表达',
  4: '写一段汇报项目进度的简短更新',
  5: '写一份确认验收条件的清单',
  6: '综合工作场景：写一段本周工作总结或下周计划（英文邮件/更新）',
};

// 生活主题日的方向池（轮换，避免每天重复）
const LIFE_THEMES = [
  '日常交流与寒暄（打招呼、聊天气、聊周末）',
  '旅行与出行（问路、订票、酒店入住）',
  '餐厅点餐与购物退换货',
  '租房、物业与房东沟通',
  '看病就医与药店买药',
  '自我介绍与介绍家乡、兴趣',
  '家庭日常与生活琐事的表达',
];

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5（最准，推荐）' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5（较快，便宜些）' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5（最快最便宜）' },
];

const DEFAULT_STATE = {
  settings: {
    apiKey: '',
    model: 'claude-opus-5-5',
    contentMode: 'alternate', // alternate | work | life
    reminders: { writing: '09:00', listening: '13:00', shadowing: '21:00' },
    jobContext: '我是一名 EPC 项目管理人员/工程师，负责电解槽、压力容器、化工装置的交付与调试（commissioning）。日常工作包括：与业主(Owner/Client)邮件沟通、催促确认技术文件、解释设备交付延迟、协商变更(Variation)、汇报项目进度、确认验收条件(FAT/SAT/acceptance)。请围绕这些真实工作场景生成内容。',
  },
  days: {},
};

/* ===================== 状态 ===================== */
let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const s = JSON.parse(raw);
    s.settings = Object.assign({}, DEFAULT_STATE.settings, s.settings || {});
    s.settings.reminders = Object.assign({}, DEFAULT_STATE.settings.reminders, (s.settings && s.settings.reminders) || {});
    s.days = s.days || {};
    return s;
  } catch (e) {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ===================== 工具函数 ===================== */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

function localDateKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function weekdayCN(d = new Date()) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}
function todayKey() { return localDateKey(); }
function dayOfYear(d = new Date()) {
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

function getToday() {
  const k = todayKey();
  if (!state.days[k]) {
    state.days[k] = {
      content: null,
      writing: { draft: '', checks: [], status: 'pending' },
      listening: { keywords: '', status: 'pending' },
      shadowing: { status: 'pending' },
    };
  }
  return state.days[k];
}

// 今天的内容类型：work 或 life
function dayType() {
  const mode = state.settings.contentMode || 'alternate';
  if (mode === 'work') return 'work';
  if (mode === 'life') return 'life';
  // 交替：一年中的奇数天=工作，偶数天=生活
  return (dayOfYear() % 2 === 1) ? 'work' : 'life';
}

function biliSearchUrl(kw) {
  return 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(kw);
}

/* ===================== AI 调用 ===================== */
async function callClaudeRaw(system, user, maxTokens) {
  const key = (state.settings.apiKey || '').trim();
  if (!key) throw new Error('还没有 API key，请先到「设置」里填入');

  const body = {
    model: state.settings.model || 'claude-opus-5-5',
    max_tokens: maxTokens || 5000,
    messages: [{ role: 'user', content: user }],
  };
  if (system) body.system = system;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg += '：' + (await res.text()).slice(0, 300); } catch (e) {}
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  if (!text) throw new Error('AI 返回为空');
  return text;
}

function extractJSON(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callClaudeJSON(system, user, maxTokens) {
  const text = await callClaudeRaw(system, user, maxTokens);
  try {
    return extractJSON(text);
  } catch (e) {
    // 再试一次解析宽松情况：直接当 JSON
    throw new Error('AI 返回的不是合法 JSON，请重试');
  }
}

/* ===================== 内容生成 ===================== */
const GEN_SYSTEM = `你是一名资深的英语教练，精通地道商务英语和日常英语，也熟悉 EPC 工程、化工与能源设备领域。你的任务是根据用户背景和当天主题，生成贴合其真实场景的英语学习内容。
你只输出一个 JSON 对象，不要输出任何解释、前后缀或 markdown 代码块。JSON 结构如下：
{
  "writing": {
    "title": "今日场景标题（中文，简短）",
    "scenario": "中文场景说明：今天要完成什么沟通任务、写给谁、什么语境",
    "reference": "一段 native 地道的英文参考范例（60~120 词）",
    "hints": ["3~5 个关键英文表达/词组，例如 follow up on, technical submittal, delivery schedule 等"]
  },
  "listening": {
    "title": "听力主题（中文）",
    "keywordsEn": ["2~4 个英文搜索关键词"],
    "keywordsZh": ["1~2 个中文搜索关键词"]
  },
  "shadowing": {
    "title": "跟读场景（中文）",
    "lines": ["6~10 句英文对话，涵盖寒暄或技术澄清的来回，每句简短可跟读"],
    "notes": "跟读提示（语音语调、重音、节奏，中文）"
  }
}`;

function genUserPrompt() {
  const type = dayType();
  const ctx = (state.settings.jobContext || '').trim() || DEFAULT_STATE.settings.jobContext;
  if (type === 'work') {
    const theme = WORK_THEMES[new Date().getDay()];
    return `我的工作背景：${ctx}\n\n今天（${weekdayCN()}）的工作场景主题：${theme}\n\n请生成今天的工作场景学习内容，只输出 JSON。`;
  } else {
    const theme = LIFE_THEMES[new Date().getDate() % LIFE_THEMES.length];
    return `今天安排的是生活场景英语（非工作相关）。生活主题方向：${theme}\n\n请生成贴近日常生活的英语学习内容，写作场景、听力关键词、跟读对话都要围绕这个生活主题，只输出 JSON。`;
  }
}

let generating = false;
async function generateContent() {
  if (generating) return;
  generating = true;
  render();
  try {
    const json = await callClaudeJSON(GEN_SYSTEM, genUserPrompt(), 5000);
    const day = getToday();
    day.content = Object.assign({ generatedAt: Date.now(), dayType: dayType() }, json);
    saveState();
  } catch (e) {
    alert('生成失败：' + e.message);
  } finally {
    generating = false;
    render();
  }
}

/* ===================== 造句检查 ===================== */
const CHECK_SYSTEM = `你是一名严格的英语教练，擅长地道商务英语和日常英语。用户会写一段英语句子（可能是工作场景，也可能是生活场景）。请逐句检查：语法、用词是否地道、语气是否得体，并给出更地道的 native 写法。
你只输出一个 JSON 对象，不要输出其他文字或 markdown 代码块。JSON 结构：
{
  "ok": true或false（是否已经足够地道、无明显问题）,
  "summary": "一句话总评（中文）",
  "issues": [{"original":"用户原句","problem":"问题说明（中文）","better":"更好的说法"}],
  "nativeVersion": "整段更地道的英文写法"
}
如果没问题，issues 为空数组。`;

function checkUserPrompt(draft) {
  const day = getToday();
  const c = day.content;
  const scene = c ? `今天场景：${c.writing.title}\n${c.writing.scenario}` : `今天场景：${WORK_THEMES[new Date().getDay()]}`;
  return `${scene}\n\n我写的英文句子：\n${draft}\n\n请检查并只输出 JSON。`;
}

let checking = false;
async function doCheck() {
  const el = document.getElementById('draftInput');
  const draft = (el ? el.value : '').trim();
  if (!draft) { alert('请先写几句英文'); return; }
  const day = getToday();
  day.writing.draft = draft;
  saveState();

  if (!(state.settings.apiKey || '').trim()) { alert('请先在「设置」里填入 API key'); render(); return; }

  checking = true;
  render();
  try {
    const json = await callClaudeJSON(CHECK_SYSTEM, checkUserPrompt(draft), 4000);
    day.writing.checks.push({ ts: Date.now(), draft, result: json });
    day.writing.status = json.ok ? 'done' : 'pending';
    saveState();
  } catch (e) {
    alert('检查失败：' + e.message);
  } finally {
    checking = false;
    render();
  }
}

function saveDraft() {
  const el = document.getElementById('draftInput');
  if (!el) return;
  getToday().writing.draft = el.value;
  saveState();
}

function markWritingDone() {
  getToday().writing.status = 'done';
  saveState();
  render();
}

/* ===================== 听力 ===================== */
let timer = { remaining: 600, running: false, interval: null };

function fmtTime(s) {
  const m = Math.floor(s / 60), ss = s % 60;
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
function startTimer() {
  if (timer.running) return;
  timer.running = true;
  timer.interval = setInterval(() => {
    timer.remaining--;
    if (timer.remaining <= 0) {
      timer.remaining = 0;
      pauseTimer();
      beep();
    }
    const el = document.getElementById('timerDisplay');
    if (el) el.textContent = fmtTime(timer.remaining);
  }, 1000);
  renderTimerButtons();
}
function pauseTimer() {
  timer.running = false;
  if (timer.interval) { clearInterval(timer.interval); timer.interval = null; }
  renderTimerButtons();
}
function resetTimer() {
  pauseTimer();
  timer.remaining = 600;
  const el = document.getElementById('timerDisplay');
  if (el) el.textContent = fmtTime(timer.remaining);
  renderTimerButtons();
}
function renderTimerButtons() {
  const s = document.getElementById('timerStartBtn');
  const p = document.getElementById('timerPauseBtn');
  if (s) s.disabled = timer.running;
  if (p) p.disabled = !timer.running;
}
function beep() {
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.2;
    o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 600);
  } catch (e) {}
}
function saveKeywords() {
  const el = document.getElementById('keywordsInput');
  if (el) { getToday().listening.keywords = el.value; saveState(); }
}
function markListeningDone() {
  getToday().listening.status = 'done';
  saveState();
  render();
}

/* ===================== 跟读 ===================== */
function speakLine(i) {
  const lines = (getToday().content && getToday().content.shadowing.lines) || [];
  if (lines[i]) speak(lines[i]);
}
function speakAll() {
  const lines = (getToday().content && getToday().content.shadowing.lines) || [];
  if (!lines.length) return;
  const text = lines.join(' ');
  speak(text);
}
function speak(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    const voices = speechSynthesis.getVoices();
    const en = voices.find(v => /^en/i.test(v.lang));
    if (en) u.voice = en;
    speechSynthesis.speak(u);
  } catch (e) {}
}
function markShadowingDone() {
  getToday().shadowing.status = 'done';
  saveState();
  render();
}

/* ===================== 设置 ===================== */
function updateSettings() {
  const key = document.getElementById('setApiKey').value;
  state.settings.apiKey = key;
  state.settings.model = document.getElementById('setModel').value;
  state.settings.contentMode = document.getElementById('setContentMode').value;
  state.settings.reminders.writing = document.getElementById('setRemindWriting').value;
  state.settings.reminders.listening = document.getElementById('setRemindListening').value;
  state.settings.reminders.shadowing = document.getElementById('setRemindShadowing').value;
  state.settings.jobContext = document.getElementById('setJobContext').value;
  saveState();
}
function toggleKeyVisibility() {
  const el = document.getElementById('setApiKey');
  el.type = el.type === 'password' ? 'text' : 'password';
}
function clearAllData() {
  if (!confirm('确定要清空所有学习记录和设置吗？此操作不可恢复。')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = loadState();
  render();
}

/* ===================== 提醒 ===================== */
function parseTime(t) { const [h, m] = String(t || '9:00').split(':').map(Number); return h * 60 + m; }
function blockOrder() {
  const day = getToday();
  return [
    { key: 'writing', tab: 'writing', name: '场景造句', time: state.settings.reminders.writing, done: day.writing.status === 'done' },
    { key: 'listening', tab: 'listening', name: '听力抓关键词', time: state.settings.reminders.listening, done: day.listening.status === 'done' },
    { key: 'shadowing', tab: 'shadowing', name: '跟读模仿', time: state.settings.reminders.shadowing, done: day.shadowing.status === 'done' },
  ];
}
function updateReminderBanner() {
  const el = document.getElementById('reminderBanner');
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const order = blockOrder();
  const done = order.filter(b => b.done);
  if (done.length === order.length) {
    el.className = 'reminder-banner alldone';
    el.innerHTML = '🎉 今日三项任务已全部完成，很棒！';
    el.onclick = null;
    return;
  }
  const upcoming = order.filter(b => !b.done && parseTime(b.time) > mins)
    .sort((a, b) => parseTime(a.time) - parseTime(b.time));
  if (upcoming.length) {
    const b = upcoming[0];
    el.className = 'reminder-banner upcoming';
    el.innerHTML = `⏰ 下一个任务：<b>${b.name}</b> · 提醒时间 ${b.time}（还没到点，点击前往）`;
    el.onclick = () => switchTab(b.tab);
    return;
  }
  const overdue = order.filter(b => !b.done);
  el.className = 'reminder-banner overdue';
  el.innerHTML = `📌 还有 <b>${overdue.length}</b> 项未完成：${overdue.map(b => b.name).join('、')}（已过提醒时间）`;
  el.onclick = () => switchTab(overdue[0].tab);
}

/* ===================== 导航 ===================== */
let activeTab = 'today';
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById('tab-' + tab);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
  window.scrollTo(0, 0);
}

/* ===================== 渲染 ===================== */
function render() {
  document.getElementById('headerDate').textContent = `${localDateKey()} ${weekdayCN()}`;
  updateReminderBanner();
  if (activeTab === 'today') renderToday();
  else if (activeTab === 'writing') renderWriting();
  else if (activeTab === 'listening') renderListening();
  else if (activeTab === 'shadowing') renderShadowing();
  else if (activeTab === 'settings') renderSettings();
}

function renderToday() {
  const day = getToday();
  const type = dayType();
  const typeBadge = type === 'work'
    ? '<span class="badge work">工作主题</span>'
    : '<span class="badge life">生活主题</span>';

  const order = blockOrder();
  const doneCount = order.filter(b => b.done).length;
  const pct = Math.round(doneCount / 3 * 100);

  let body = '';
  body += `<div class="card">
    <h2>今日 · ${weekdayCN()} ${typeBadge}</h2>
    <div class="sub">${type === 'work' ? WORK_THEMES[new Date().getDay()] : '生活场景英语（点进「造句」看具体场景）'}</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="sub">已完成 ${doneCount} / 3</div>
  </div>`;

  if (!day.content) {
    body += `<div class="card">
      <h2>今日内容</h2>
      ${generating
        ? '<div class="alert alert-info">🤖 AI 正在生成今天的内容，请稍候…</div>'
        : (state.settings.apiKey
          ? '<div class="alert alert-warn">今天的场景还没有生成。</div><button class="btn btn-primary btn-block" onclick="generateContent()">生成今日内容</button>'
          : '<div class="alert alert-warn">请先到「设置」里填入 API key，然后回来生成今天的场景。</div>')}
    </div>`;
  } else {
    const c = day.content;
    body += `<div class="card">
      <h2>📝 ${esc(c.writing.title || '场景')}</h2>
      <div class="sub">${nl2br(c.writing.scenario || '')}</div>
      <button class="btn btn-accent" onclick="switchTab(\'writing\')">去做造句 →</button>
      <div class="divider"></div>
      <h2>🎧 ${esc(c.listening.title || '听力')}</h2>
      <button class="btn btn-accent" onclick="switchTab(\'listening\')">去做听力 →</button>
      <div class="divider"></div>
      <h2>🗣️ ${esc(c.shadowing.title || '跟读')}</h2>
      <button class="btn btn-accent" onclick="switchTab(\'shadowing\')">去做跟读 →</button>
    </div>`;
    body += `<div class="card"><button class="btn btn-ghost btn-block" onclick="if(confirm(\'重新生成会覆盖今天的内容，确定吗？\'))generateContent()">🔄 重新生成今天内容</button></div>`;
  }

  body += `<div class="card"><h2>今日任务</h2><div class="task-list">` +
    order.map(b => `
      <div class="task" onclick="switchTab('${b.tab}')">
        <span class="task-ico">${b.key === 'writing' ? '✍️' : b.key === 'listening' ? '🎧' : '🗣️'}</span>
        <span class="task-body">
          <span class="task-name">${b.name}</span><br>
          <span class="task-time">提醒时间 ${b.time}</span>
        </span>
        ${b.done ? '<span class="badge done">已完成</span>' : '<span class="badge pending">未完成</span>'}
        <span class="task-arrow">›</span>
      </div>`).join('') +
    `</div></div>`;

  document.getElementById('tab-today').innerHTML = body;
}

function renderWriting() {
  const day = getToday();
  const type = dayType();
  const typeBadge = type === 'work' ? '<span class="badge work">工作主题</span>' : '<span class="badge life">生活主题</span>';
  const st = day.writing.status;

  if (!day.content) {
    document.getElementById('tab-writing').innerHTML = `<div class="card">
      <h2>场景造句 ${typeBadge}</h2>
      ${generating ? '<div class="alert alert-info">🤖 正在生成今日场景…</div>'
        : (state.settings.apiKey
          ? '<div class="alert alert-warn">今天的场景还没生成，请先在「今日」页生成。</div><button class="btn btn-primary btn-block" onclick="generateContent()">生成今日内容</button>'
          : '<div class="alert alert-warn">请先到「设置」填 API key。</div>')}
    </div>`;
    return;
  }

  const c = day.content.writing;
  const last = day.writing.checks[day.writing.checks.length - 1];

  let html = `<div class="card">
    <h2>✍️ 场景造句 ${typeBadge}</h2>
    <div class="sub">${st === 'done' ? '<span class="badge done">已完成</span>' : '<span class="badge pending">进行中</span>'}</div>
    <div style="margin-top:6px"><b>场景：</b>${nl2br(c.title + '\n' + c.scenario)}</div>`;

  if (c.hints && c.hints.length) {
    html += `<div style="margin-top:10px"><b>关键表达提示：</b><br>` +
      c.hints.map(h => `<span class="chip">${esc(h)}</span>`).join('') + `</div>`;
  }

  html += `<details><summary>参考范文（先自己写，写完再点开）</summary><div class="reference">${esc(c.reference)}</div></details>`;

  html += `<label>写 3~5 句英文：</label>
    <textarea id="draftInput" placeholder="在这里写下你的英文句子…" oninput="saveDraft()">${esc(day.writing.draft)}</textarea>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="doCheck()" ${checking ? 'disabled' : ''}>${checking ? '检查中…' : '🔍 AI 检查'}</button>
      <button class="btn btn-success" onclick="markWritingDone()">✅ 标记完成</button>
    </div>
  </div>`;

  if (last) {
    const r = last.result || {};
    html += `<div class="card"><h2>最近一次检查结果</h2>`;
    if (r.ok) {
      html += `<div class="alert alert-ok">✅ 这版已经没问题了，很地道！可以标记完成。</div>`;
    } else {
      html += `<div class="alert alert-warn">${esc(r.summary || '还有改进空间')}</div>`;
      (r.issues || []).forEach(it => {
        html += `<div class="issue"><div class="orig">❌ ${esc(it.original)}</div><div>${esc(it.problem)}</div><div class="better">✅ ${esc(it.better)}</div></div>`;
      });
    }
    if (r.nativeVersion) {
      html += `<div class="sub" style="margin-top:8px">更地道的整体写法：</div><div class="native-box">${esc(r.nativeVersion)}</div>`;
    }
    html += `</div>`;
  }

  if (day.writing.checks.length > 1) {
    html += `<div class="card"><details><summary>历史检查（${day.writing.checks.length} 次）</summary>`;
    [...day.writing.checks].reverse().forEach((ch, idx) => {
      const r = ch.result || {};
      html += `<div style="margin-top:10px;font-size:13px"><b>${r.ok ? '✅' : '🔸'} ${new Date(ch.ts).toLocaleTimeString()}</b>：${esc(r.summary || '')}</div>`;
    });
    html += `</details></div>`;
  }

  document.getElementById('tab-writing').innerHTML = html;
}

function renderListening() {
  const day = getToday();
  const type = dayType();
  const typeBadge = type === 'work' ? '<span class="badge work">工作主题</span>' : '<span class="badge life">生活主题</span>';

  if (!day.content) {
    document.getElementById('tab-listening').innerHTML = `<div class="card">
      <h2>🎧 听力抓关键词 ${typeBadge}</h2>
      ${state.settings.apiKey ? '<div class="alert alert-warn">今天的内容还没生成，请先在「今日」页生成。</div>' : '<div class="alert alert-warn">请先到「设置」填 API key。</div>'}
    </div>`;
    return;
  }

  const c = day.content.listening;
  const links = [...(c.keywordsEn || []).map(k => ({ label: '英文：' + k, url: biliSearchUrl(k) })),
    ...(c.keywordsZh || []).map(k => ({ label: '中文：' + k, url: biliSearchUrl(k) }))];

  let html = `<div class="card">
    <h2>🎧 听力抓关键词 ${typeBadge}</h2>
    <div class="sub">${day.listening.status === 'done' ? '<span class="badge done">已完成</span>' : '<span class="badge pending">未完成</span>'}</div>
    <div style="margin-bottom:6px"><b>主题：</b>${esc(c.title || '')}</div>
    <div class="sub">点下面链接，去 B站搜索并听 10 分钟，只抓关键词、不用逐字听懂：</div>`;

  links.forEach(l => {
    html += `<div style="margin:6px 0"><a href="${esc(l.url)}" target="_blank" rel="noopener" style="color:#4f46e5;font-size:14px">🔗 B站搜「${esc(l.label)}」→</a></div>`;
  });

  html += `<div class="divider"></div>
    <div class="sub" style="text-align:center">计时 10 分钟</div>
    <div class="timer-display" id="timerDisplay">${fmtTime(timer.remaining)}</div>
    <div class="btn-row">
      <button class="btn btn-accent" id="timerStartBtn" onclick="startTimer()">▶ 开始</button>
      <button class="btn btn-ghost" id="timerPauseBtn" onclick="pauseTimer()">⏸ 暂停</button>
      <button class="btn btn-ghost" onclick="resetTimer()">↺ 重置</button>
    </div>
    <label>听的时候抓到的关键词（中英文都行）：</label>
    <textarea id="keywordsInput" placeholder="例如：commissioning, FAT, 业主, 压力容器…" oninput="saveKeywords()">${esc(day.listening.keywords)}</textarea>
    <div class="btn-row"><button class="btn btn-success btn-block" onclick="markListeningDone()">✅ 完成今天的听力</button></div>
  </div>`;

  document.getElementById('tab-listening').innerHTML = html;
  renderTimerButtons();
}

function renderShadowing() {
  const day = getToday();
  const type = dayType();
  const typeBadge = type === 'work' ? '<span class="badge work">工作主题</span>' : '<span class="badge life">生活主题</span>';

  if (!day.content) {
    document.getElementById('tab-shadowing').innerHTML = `<div class="card">
      <h2>🗣️ 跟读模仿 ${typeBadge}</h2>
      ${state.settings.apiKey ? '<div class="alert alert-warn">今天的内容还没生成，请先在「今日」页生成。</div>' : '<div class="alert alert-warn">请先到「设置」填 API key。</div>'}
    </div>`;
    return;
  }

  const c = day.content.shadowing;
  const lines = c.lines || [];

  let html = `<div class="card">
    <h2>🗣️ 跟读模仿 ${typeBadge}</h2>
    <div class="sub">${day.shadowing.status === 'done' ? '<span class="badge done">已完成</span>' : '<span class="badge pending">未完成</span>'}</div>
    <div style="margin-bottom:6px"><b>场景：</b>${esc(c.title || '')}</div>`;

  if (c.notes) html += `<div class="sub">💡 ${esc(c.notes)}</div>`;

  html += `<div class="btn-row">
      <button class="btn btn-accent" onclick="speakAll()">▶ 连续朗读全文</button>
    </div>
    <div class="divider"></div>`;

  lines.forEach((line, i) => {
    html += `<div class="shadow-line"><button class="speak-btn" onclick="speakLine(${i})">▶</button><span>${esc(line)}</span></div>`;
  });

  html += `<div class="btn-row"><button class="btn btn-success btn-block" onclick="markShadowingDone()">✅ 完成今天的跟读</button></div>
  </div>`;

  document.getElementById('tab-shadowing').innerHTML = html;
}

function renderSettings() {
  const s = state.settings;
  const html = `<div class="card">
    <h2>⚙️ 设置</h2>

    <label>Anthropic API key（内置 AI 需要）</label>
    <div style="display:flex;gap:8px">
      <input type="password" id="setApiKey" value="${esc(s.apiKey)}" placeholder="sk-ant-…" oninput="updateSettings()">
      <button class="btn btn-ghost" onclick="toggleKeyVisibility()" style="flex-shrink:0">👁</button>
    </div>
    <div class="sub" style="margin-top:6px">key 只保存在你手机本地，不会上传。获取方法见 README。</div>

    <label>AI 模型</label>
    <select id="setModel" onchange="updateSettings()">
      ${MODELS.map(m => `<option value="${m.id}" ${s.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
    </select>

    <label>内容节奏</label>
    <select id="setContentMode" onchange="updateSettings()">
      <option value="alternate" ${s.contentMode === 'alternate' ? 'selected' : ''}>自动交替（一天工作、一天生活）</option>
      <option value="work" ${s.contentMode === 'work' ? 'selected' : ''}>全是工作场景</option>
      <option value="life" ${s.contentMode === 'life' ? 'selected' : ''}>全是生活场景</option>
    </select>

    <label>三个提醒时间点</label>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:8px"><span style="width:90px">✍️ 造句</span><input type="time" id="setRemindWriting" value="${esc(s.reminders.writing)}" onchange="updateSettings()"></div>
      <div style="display:flex;align-items:center;gap:8px"><span style="width:90px">🎧 听力</span><input type="time" id="setRemindListening" value="${esc(s.reminders.listening)}" onchange="updateSettings()"></div>
      <div style="display:flex;align-items:center;gap:8px"><span style="width:90px">🗣️ 跟读</span><input type="time" id="setRemindShadowing" value="${esc(s.reminders.shadowing)}" onchange="updateSettings()"></div>
    </div>
    <div class="sub" style="margin-top:6px">说明：本应用只在打开时提醒（关掉 App 收不到推送）。</div>

    <label>我的工作背景（用于生成贴合工作的内容）</label>
    <textarea id="setJobContext" oninput="updateSettings()">${esc(s.jobContext)}</textarea>

    <div class="divider"></div>
    <button class="btn btn-ghost btn-block" style="color:#dc2626" onclick="clearAllData()">🗑 清空所有数据</button>
  </div>`;

  document.getElementById('tab-settings').innerHTML = html;
}

/* ===================== 启动 ===================== */
function init() {
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  render();
  // 有 key 且今天还没内容时，自动生成
  const day = getToday();
  if (!day.content && (state.settings.apiKey || '').trim()) {
    generateContent();
  }
}

init();
