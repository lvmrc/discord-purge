// ==UserScript==
// @name         Purge – Discord message cleaner
// @namespace    local.purge
// @version      1.0.1
// @description  Delete your own Discord messages by date range (calendar), keywords, or a vulgar-word list, with rate-limit-safe pacing.
// @match        https://discord.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Config
   * ------------------------------------------------------------------ */
  const API = 'https://discord.com/api/v9';
  const DISCORD_EPOCH = 1420070400000n;
  const isDeletableType = (t) => t === 0 || (t >= 6 && t <= 21); // same rule Undiscord uses
  const SPEEDS = {
    safe:   { del: [2200, 4200], search: [2500, 4000], breakEvery: 20, breakMs: [10000, 20000] },
    normal: { del: [1200, 2400], search: [1800, 3000], breakEvery: 30, breakMs: [8000, 15000] },
    fast:   { del: [800, 1500],  search: [1500, 2500], breakEvery: 40, breakMs: [5000, 9000] },
  };
  const DEFAULT_VULGAR = [
    'fuck', 'fucking', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cock',
    'pussy', 'cunt', 'slut', 'whore', 'damn', 'piss', 'wtf', 'stfu',
  ];

  /* ------------------------------------------------------------------ *
   *  Helpers
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
  const toSnowflake = (ms) => ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fmt = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  const state = { running: false, stop: false, extraDelay: 0, token: null, me: null };

  function getToken() {
    if (state.token) return state.token;
    let token = null;
    // Method 1: read the token from Discord's own already-logged-in session (no storage tricks)
    try {
      let found = null;
      window.webpackChunkdiscord_app.push([[Symbol()], {}, (req) => {
        for (const m of Object.values(req.c || {})) {
          try {
            const ex = m.exports;
            for (const c of [ex?.default, ex?.Z, ex]) {
              if (c && typeof c.getToken === 'function') {
                const t = c.getToken();
                if (typeof t === 'string') found = t;
              }
            }
          } catch (_) {}
        }
      }]);
      window.webpackChunkdiscord_app.pop();
      token = found;
    } catch (_) {}
    // Method 2 (fallback only): iframe localStorage. No beforeunload event, which can sign you out.
    if (!token) {
      try {
        const ifr = document.body.appendChild(document.createElement('iframe'));
        const raw = ifr.contentWindow.localStorage.token;
        ifr.remove();
        if (raw) token = JSON.parse(raw);
      } catch (_) {}
    }
    state.token = token;
    return token;
  }

  function getContext() {
    const m = location.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
    if (!m) return null;
    return { guild: m[1], channel: m[2], isDM: m[1] === '@me' };
  }

  /* ------------------------------------------------------------------ *
   *  API wrapper with rate-limit handling
   * ------------------------------------------------------------------ */
  async function api(path, opts = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (state.stop) throw new Error('stopped');
      const res = await fetch(API + path, {
        ...opts,
        headers: { Authorization: getToken(), 'Content-Type': 'application/json' },
      });
      if (res.status === 429 || res.status === 202) {
        const j = await res.json().catch(() => ({}));
        const wait = (j.retry_after || 5) * 1000 + rand(500, 1500);
        if (res.status === 429) state.extraDelay = Math.min(state.extraDelay + 400, 5000);
        log(res.status === 429
          ? `Rate limited. Waiting ${(wait / 1000).toFixed(1)}s…`
          : `Discord is indexing. Waiting ${(wait / 1000).toFixed(1)}s…`);
        await sleep(wait);
        continue;
      }
      return res;
    }
    throw new Error('Too many retries');
  }

  /* ------------------------------------------------------------------ *
   *  Core purge logic
   * ------------------------------------------------------------------ */
  function buildMatcher(opts) {
    const words = [];
    if (opts.useKeywords) words.push(...opts.keywords);
    if (opts.useVulgar) words.push(...opts.vulgar);
    const clean = [...new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean))];
    if (!clean.length) return null;
    const body = clean.map(esc).join('|');
    const re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body, 'iu');
    return (msg) => re.test(msg.content || '');
  }

  async function run(opts) {
    const ctx = opts.ctx;
    const speed = SPEEDS[opts.speed];
    const matcher = buildMatcher(opts);
    const filterByWords = opts.useKeywords || opts.useVulgar;
    if (filterByWords && !matcher) { log('No keywords entered.'); return; }

    const qs = new URLSearchParams({ author_id: state.me, sort_by: 'timestamp', sort_order: 'asc' });
    if (opts.start) qs.set('min_id', toSnowflake(opts.start.getTime()));
    if (opts.end) qs.set('max_id', toSnowflake(opts.end.getTime() + 86400000));
    let base;
    if (ctx.isDM) {
      base = `/channels/${ctx.channel}/messages/search`;       // DMs / group DMs
    } else {
      base = `/guilds/${ctx.guild}/messages/search`;           // servers always use the guild endpoint
      if (opts.scope === 'channel') qs.set('channel_id', ctx.channel);
      else qs.set('include_nsfw', 'true');
    }

    let skipped = 0, deleted = 0, matched = 0, total = null, sinceBreak = 0;

    while (!state.stop) {
      qs.set('offset', String(skipped));
      const res = await api(`${base}?${qs}`);
      if (!res.ok) { log(`Search failed (HTTP ${res.status}). Stopping.`); break; }
      const json = await res.json();
      if (total === null) { total = json.total_results; log(`Discord reports ${total} of your messages in this range.`); }

      const hits = (json.messages || []).map((g) => g.find((m) => m.hit)).filter(Boolean);
      if (!hits.length) break;

      for (const msg of hits) {
        if (state.stop) break;
        const ok =
          isDeletableType(msg.type) &&
          !(opts.keepPinned && msg.pinned) &&
          (!filterByWords || matcher(msg));
        if (!ok) { skipped++; continue; }

        matched++;
        const when = new Date(msg.timestamp).toLocaleString();
        const preview = (msg.content || '[attachment/embed]').replace(/\s+/g, ' ').slice(0, 70);

        if (opts.preview) {
          log(`WOULD DELETE  ${when}  "${preview}"`);
          skipped++; // keeps paging forward without deleting
          continue;
        }

        const r = await api(`/channels/${msg.channel_id}/messages/${msg.id}`, { method: 'DELETE' });
        if (r.status === 204 || r.status === 404) {
          deleted++;
          log(`Deleted  ${when}  "${preview}"`);
        } else {
          skipped++;
          log(`Could not delete (HTTP ${r.status}): "${preview}"`);
        }
        setProgress(opts.preview ? matched : deleted, skipped, total);

        sinceBreak++;
        if (sinceBreak >= speed.breakEvery + rand(-5, 5)) {
          const b = rand(...speed.breakMs);
          log(`Taking a ${(b / 1000).toFixed(0)}s break…`);
          await sleep(b);
          sinceBreak = 0;
        } else {
          await sleep(rand(...speed.del) + state.extraDelay);
        }
      }
      setProgress(opts.preview ? matched : deleted, skipped, total);
      await sleep(rand(...speed.search) + state.extraDelay);
    }

    log(state.stop ? 'Stopped.' : opts.preview
      ? `Preview done. ${matched} message(s) would be deleted.`
      : `Done. Deleted ${deleted} message(s).`);
  }

  /* ------------------------------------------------------------------ *
   *  UI
   * ------------------------------------------------------------------ */
  let $, logEl, progEl, calState;

  function log(t) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.textContent = t;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.childNodes.length > 400) logEl.firstChild.remove();
  }
  function setProgress(done, skipped, total) {
    if (progEl) progEl.textContent = `Deleted/matched: ${done}   Skipped: ${skipped}   Total found: ${total ?? '?'}`;
  }

  function buildUI() {
    if (document.getElementById('pg-root')) return;

    const style = document.createElement('style');
    style.textContent = `
      #pg-fab{position:fixed;right:18px;bottom:18px;z-index:99999;width:46px;height:46px;border-radius:50%;
        border:none;background:#5865f2;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}
      #pg-fab:hover{background:#4752c4}
      #pg-panel{position:fixed;right:18px;bottom:74px;z-index:99999;width:360px;max-height:82vh;overflow:auto;
        background:#2b2d31;color:#dbdee1;border-radius:10px;padding:14px;font:13px/1.4 system-ui,sans-serif;
        box-shadow:0 8px 30px rgba(0,0,0,.6);display:none}
      #pg-panel *{box-sizing:border-box}
      #pg-panel h3{margin:0 0 10px;font-size:16px;color:#fff}
      #pg-panel label{display:block;margin:8px 0 3px;font-weight:600;font-size:12px;color:#b5bac1;text-transform:uppercase}
      #pg-panel select,#pg-panel textarea{width:100%;background:#1e1f22;color:#dbdee1;border:1px solid #111214;border-radius:5px;padding:6px}
      #pg-panel textarea{height:54px;resize:vertical}
      #pg-panel .pg-row{display:flex;gap:8px;align-items:center;margin:4px 0}
      #pg-panel .pg-row label{margin:0;text-transform:none;font-weight:400;font-size:13px;color:#dbdee1}
      .pg-cal{background:#1e1f22;border-radius:8px;padding:8px;margin-top:4px}
      .pg-cal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;color:#fff;font-weight:600}
      .pg-cal-head button{background:none;border:none;color:#b5bac1;font-size:16px;cursor:pointer;padding:2px 10px}
      .pg-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}
      .pg-dow{color:#80848e;font-size:11px;padding:2px}
      .pg-day{padding:6px 0;border-radius:5px;cursor:pointer}
      .pg-day:hover{background:#35373c}
      .pg-day.in{background:#3c4270}
      .pg-day.edge{background:#5865f2;color:#fff}
      .pg-range{margin-top:6px;color:#b5bac1;font-size:12px}
      .pg-link{color:#00a8fc;cursor:pointer;margin-left:8px}
      .pg-btns{display:flex;gap:8px;margin-top:12px}
      .pg-btns button{flex:1;padding:9px;border:none;border-radius:5px;font-weight:600;cursor:pointer;color:#fff}
      #pg-start{background:#da373c}#pg-stop{background:#4e5058}
      #pg-prog{margin-top:10px;font-size:12px;color:#b5bac1}
      #pg-log{margin-top:6px;height:150px;overflow:auto;background:#1e1f22;border-radius:5px;padding:6px;
        font:11px/1.35 ui-monospace,monospace;color:#a3a6aa;white-space:pre-wrap}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'pg-root';
    root.innerHTML = `
      <button id="pg-fab" title="Purge messages">🧹</button>
      <div id="pg-panel">
        <h3>Purge my messages</h3>

        <label>Where</label>
        <select id="pg-scope">
          <option value="channel">This channel / DM only</option>
          <option value="guild">Entire server (if in a server)</option>
        </select>

        <label>Date range (click start day, then end day)</label>
        <div class="pg-cal">
          <div class="pg-cal-head"><button id="pg-prev">‹</button><span id="pg-title"></span><button id="pg-next">›</button></div>
          <div class="pg-grid" id="pg-grid"></div>
        </div>
        <div class="pg-range"><span id="pg-rangetxt">All time</span><span class="pg-link" id="pg-clear">clear</span></div>

        <label>Which messages</label>
        <div class="pg-row"><input type="checkbox" id="pg-usekw"><label for="pg-usekw">Only messages containing my keywords</label></div>
        <textarea id="pg-kw" placeholder="comma separated: word1, word2, phrase here"></textarea>
        <div class="pg-row"><input type="checkbox" id="pg-usevulgar"><label for="pg-usevulgar">Only messages with vulgar words (list below)</label></div>
        <textarea id="pg-vulgar"></textarea>
        <div class="pg-row"><input type="checkbox" id="pg-whole" checked><label for="pg-whole">Match whole words only</label></div>
        <div class="pg-row"><input type="checkbox" id="pg-pinned" checked><label for="pg-pinned">Keep pinned messages</label></div>
        <div style="color:#80848e;font-size:11px">If neither box is ticked, ALL your messages in the range are deleted.</div>

        <label>Speed</label>
        <select id="pg-speed">
          <option value="safe">Safe (slowest, least risk)</option>
          <option value="normal" selected>Normal</option>
          <option value="fast">Fast (more risk)</option>
        </select>

        <div class="pg-row" style="margin-top:10px"><input type="checkbox" id="pg-preview" checked><label for="pg-preview">Preview only (don't delete, just list matches)</label></div>

        <div class="pg-btns"><button id="pg-start">Start</button><button id="pg-stop">Stop</button></div>
        <div id="pg-prog"></div>
        <div id="pg-log"></div>
      </div>`;
    document.body.appendChild(root);

    $ = (id) => document.getElementById(id);
    logEl = $('pg-log');
    progEl = $('pg-prog');
    $('pg-vulgar').value = DEFAULT_VULGAR.join(', ');

    const toggle = () => {
      const p = $('pg-panel');
      p.style.display = p.style.display === 'block' ? 'none' : 'block';
    };
    $('pg-fab').onclick = toggle;

    // Also mount a button in Discord's top toolbar (same trick Undiscord uses)
    const tbBtn = document.createElement('div');
    tbBtn.id = 'pg-tb';
    tbBtn.title = 'Purge messages';
    tbBtn.textContent = '🧹';
    tbBtn.style.cssText = 'cursor:pointer;margin:0 8px;font-size:18px;user-select:none';
    tbBtn.onclick = toggle;
    const mountTb = () => {
      const bar = document.querySelector('#app-mount [class*="-toolbar"]');
      if (bar && !bar.contains(tbBtn)) bar.appendChild(tbBtn);
    };
    mountTb();
    setInterval(mountTb, 3000);

    /* ---- calendar ---- */
    const now = new Date();
    calState = { y: now.getFullYear(), m: now.getMonth(), start: null, end: null };
    $('pg-prev').onclick = () => { if (--calState.m < 0) { calState.m = 11; calState.y--; } renderCal(); };
    $('pg-next').onclick = () => { if (++calState.m > 11) { calState.m = 0; calState.y++; } renderCal(); };
    $('pg-clear').onclick = () => { calState.start = calState.end = null; renderCal(); };
    renderCal();

    $('pg-stop').onclick = () => { state.stop = true; };
    $('pg-start').onclick = onStart;
  }

  function renderCal() {
    const { y, m, start, end } = calState;
    const grid = $('pg-grid');
    $('pg-title').textContent = new Date(y, m, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
    grid.innerHTML = '';
    const add = (cls, txt) => { const d = document.createElement('div'); d.className = cls; d.textContent = txt; grid.appendChild(d); return d; };
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => add('pg-dow', d));
    for (let i = 0; i < new Date(y, m, 1).getDay(); i++) add('', '');
    const s = start?.getTime(), e = (end || start)?.getTime();
    for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++) {
      const dt = new Date(y, m, d), t = dt.getTime();
      const el = add('pg-day', d);
      if (s != null && t >= s && t <= e) el.classList.add('in');
      if (t === s || t === e) el.classList.add('edge');
      el.onclick = () => {
        if (!calState.start || calState.end) { calState.start = dt; calState.end = null; }
        else if (dt < calState.start) { calState.start = dt; }
        else { calState.end = dt; }
        renderCal();
      };
    }
    $('pg-rangetxt').textContent = !start ? 'All time'
      : !end ? `${fmt(start)} (pick an end day, or leave for just this day)`
      : start.getTime() === end.getTime() ? fmt(start) : `${fmt(start)} → ${fmt(end)}`;
  }

  async function onStart() {
    if (state.running) return;
    const ctx = getContext();
    if (!ctx) { log('Open a server channel or DM first.'); return; }
    if (!getToken()) { log('Could not read your Discord token. Try reloading the page.'); return; }

    const preview = $('pg-preview').checked;
    const opts = {
      ctx,
      scope: $('pg-scope').value,
      start: calState.start,
      end: calState.end || calState.start,
      useKeywords: $('pg-usekw').checked,
      keywords: $('pg-kw').value.split(','),
      useVulgar: $('pg-usevulgar').checked,
      vulgar: $('pg-vulgar').value.split(','),
      wholeWord: $('pg-whole').checked,
      keepPinned: $('pg-pinned').checked,
      speed: $('pg-speed').value,
      preview,
    };

    if (!preview) {
      const range = opts.start ? `${fmt(opts.start)} → ${fmt(opts.end)}` : 'ALL TIME';
      const what = (opts.useKeywords || opts.useVulgar) ? 'matching messages' : 'ALL your messages';
      if (!confirm(`Permanently delete ${what}\nRange: ${range}\nScope: ${opts.scope === 'guild' && !ctx.isDM ? 'entire server' : 'this channel'}\n\nThis cannot be undone.`)) return;
    }

    state.running = true; state.stop = false; state.extraDelay = 0;
    logEl.textContent = '';
    $('pg-start').disabled = true;
    try {
      const me = await api('/users/@me');
      state.me = (await me.json()).id;
      await run(opts);
    } catch (e) {
      if (e.message !== 'stopped') log('Error: ' + e.message);
      else log('Stopped.');
    } finally {
      state.running = false;
      $('pg-start').disabled = false;
    }
  }

  /* Discord is a SPA that can re-render the body; make sure the button survives. */
  buildUI();
  setInterval(() => { if (!document.getElementById('pg-root')) buildUI(); }, 3000);
})();
