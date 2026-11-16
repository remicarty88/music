"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const bare = (id) => String(id).split(":")[0];
const ic = (name, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ---------- Telegram Mini App ---------- */
const tg = window.Telegram && window.Telegram.WebApp;
const inTg = !!(tg && tg.initData);
const BG = "#121212";
if (tg) {
  try { tg.ready(); tg.expand(); } catch (_) {}
  try { tg.disableVerticalSwipes(); } catch (_) {}          // свайп вниз не закрывает приложение
  try { tg.setHeaderColor(BG); tg.setBackgroundColor(BG); tg.setBottomBarColor("#121212"); } catch (_) {}
}
const haptic = (kind = "light") => { try { tg.HapticFeedback.impactOccurred(kind); } catch (_) {} };
const hapticNote = (kind) => { try { tg.HapticFeedback.notificationOccurred(kind); } catch (_) {} };
if (inTg) $("#back").hidden = true;                          // в Telegram есть своя кнопка «Назад»

async function api(path, body) {
  const opts = { headers: { "X-Tg-Init-Data": (tg && tg.initData) || "" } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch("/api/" + path, opts);
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error((j && j.error) || "Ошибка " + r.status);
  return j;
}

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
};
const big = (url) => (url ? url.replace("200x200", "400x400") : "");
const coverImg = (url, cls = "cover") => `<img class="${cls}" src="${esc(url || "")}" alt="" decoding="async" onload="this.classList.add('ld')" onerror="this.classList.add('ld');this.style.visibility='hidden'">`;

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};

/* ---------- Эквалайзер для автозвука ----------
   Конкретные частоты (Гц), как на магнитоле. Нажал на частоту — крутишь её ползунком.
   Гейны в дБ (-12…+12). Список с упором на низкие (бас/саб), как просил пользователь. */
const EQ_FREQS = [33, 35, 37, 40, 45, 50, 56, 63, 71, 80, 90, 100, 112, 125, 140, 160, 180, 200, 224, 250, 280, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1120, 1250, 1400, 1600, 1800, 2000, 2240, 2500, 2800, 3150, 3550, 4000, 4500, 5000, 5600, 6300, 7100, 8000, 9000, 10000, 11200, 12500, 14000, 16000];
const EQ_PRESETS = {
  flat: { name: "Стандарт", gain: {} },
  warm: { name: "33-37Гц", gain: { 33: 10, 35: 12, 37: 11, 40: 8, 45: 5, 50: 3, 56: 1, 63: 0, 71: -1, 80: -1, 100: -2, 125: -2, 160: -3, 200: -3, 250: -2, 500: -1, 1000: 0, 2000: 0, 4000: 1, 8000: 2, 16000: 2 } },
};

function loadEqGain() {
  try {
    const g = JSON.parse(store.get("ton.eqGain") || "null");
    if (g && typeof g === "object") {
      const out = {};
      EQ_FREQS.forEach((f) => { out[f] = Number(g[f]) || 0; });
      return out;
    }
  } catch (_) {}
  const p = EQ_PRESETS[store.get("ton.eqPreset")];
  const out = {};
  EQ_FREQS.forEach((f) => { out[f] = ((p && p.gain[f]) || 0); });
  return out;
}

/* ---------- Состояние ---------- */
const S = {
  authorized: false,
  liked: { track: new Set(), artist: new Set(), album: new Set() },
  quality: ["economy", "standard", "high"].includes(store.get("ton.quality")) ? store.get("ton.quality") : "high",
  shuffle: store.get("ton.shuffle") === "1",
  repeat: ["off", "all", "one"].includes(store.get("ton.repeat")) ? store.get("ton.repeat") : "off",
  eqOn: store.get("ton.eqOn") === "1",
  eqPreset: store.get("ton.eqPreset") || "flat",
  eqGain: loadEqGain(),
  eqActive: Number(store.get("ton.eqActive")) || 80,   // выбранная частота, которую крутим
};

/* ---------- Нравится ---------- */
const isLiked = (kind, id) => S.liked[kind].has(bare(id));
const heartBtn = (kind, id, cls = "") =>
  `<button class="heart ${cls} ${isLiked(kind, id) ? "on" : ""}" data-like="${kind}" data-id="${esc(id)}"
     data-bare="${esc(bare(id))}" aria-label="Нравится">${ic("heart")}</button>`;

function setLiked(kind, b, on) {
  on ? S.liked[kind].add(b) : S.liked[kind].delete(b);
  document.querySelectorAll(`[data-like="${kind}"]`).forEach((el) => {
    if (el.dataset.bare === b) el.classList.toggle("on", on);
  });
}

async function toggleLike(kind, id) {
  if (!S.authorized) return toast("Для лайков нужен токен Яндекс Музыки");
  const b = bare(id), on = !S.liked[kind].has(b);
  haptic(on ? "medium" : "light");
  setLiked(kind, b, on);
  try {
    await api("like", { kind, id, like: on });
  } catch (e) {
    setLiked(kind, b, !on);
    hapticNote("error");
    toast("Не получилось: " + e.message);
  }
}

const artistLinks = (item) => {
  const list = item.artist_list || [];
  if (!list.length) return esc(item.artists || "");
  return list.map((a) => `<a class="lnk" href="#/artist/${esc(a.id)}">${esc(a.name)}</a>`).join(", ");
};

/* ---------- Плеер ----------
   Два <audio> по очереди: пока звучит один, во втором уже загружен следующий трек.
   Поэтому переключение происходит мгновенно, без ожидания сети. */
const audioEls = [$("#audioA"), $("#audioB")];
let ai = 0;                       // индекс активного элемента
let audio = audioEls[0];          // активный элемент — с ним работает весь остальной код
const spare = () => audioEls[1 - ai];
const swap = () => { ai = 1 - ai; audio = audioEls[ai]; };

let queue = [], qi = -1, cur = null, loadToken = 0;
let wave = null;          // {station, name, batchId, pending}
let viewKind = null;
let viewTracks = [];
let seeking = false;

const streamKey = (t, q = S.quality) => t.id + "|" + q;
const streamCache = new Map();    // "id|quality" -> кодек/битрейт (для подписи качества)
let prefetchKey = null;           // что сейчас готовим в свободном элементе
const qinfoEl = { textContent: "" };   // подпись качества убрана из интерфейса
const qinfo = (s) => `${String(s.codec || "").toUpperCase()}, ${s.bitrate || "?"} кбит/с`;

/* Звук идёт через наш прокси: так источник same-origin и работает Web Audio (эквалайзер).
   <audio> не умеет свои заголовки, поэтому initData Telegram передаём в ?t=. */
const audioUrl = (t, q = S.quality) =>
  `/api/audio/${encodeURIComponent(t.id)}?quality=${q}&t=${encodeURIComponent((tg && tg.initData) || "")}`;

async function getStream(t, quality = S.quality) {
  const key = streamKey(t, quality);
  if (streamCache.has(key)) return streamCache.get(key);
  const s = await api(`stream/${encodeURIComponent(t.id)}?quality=${quality}`);
  streamCache.set(key, s);
  return s;
}

function showQinfo(t) {
  getStream(t).then((s) => { if (cur === t) qinfoEl.textContent = qinfo(s); }).catch(() => {});
}

/* iOS разрешает звук только после касания. Прогреваем тишиной оба элемента при первом
   касании, тогда play() после сетевого запроса уже не блокируется. */
let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  ensureEq();                       // AudioContext создаём в жесте пользователя (требование iOS)
  if (audioEls.some((el) => el.src)) return;
  const dv = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36, true); w(8, "WAVEfmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true);
  dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, 0, true);
  const url = URL.createObjectURL(new Blob([dv], { type: "audio/wav" }));
  audioEls.forEach((el) => { el.src = url; el.play().then(() => { if (el.src === url) el.pause(); }).catch(() => {}); });
}
["touchend", "click"].forEach((ev) => document.addEventListener(ev, unlockAudio, { once: true, capture: true }));

function fb(type, t, seconds) {
  if (!wave) return;
  api("wave/feedback", { type, station: wave.station, track_id: t ? t.id : undefined, seconds: seconds || 0, batch_id: wave.batchId }).catch(() => {});
}

/* Заранее кладём следующий трек в свободный элемент — он успевает загрузиться. */
function prefetchNext() {
  if (!cur) return;
  const n = nextIndex();
  if (n < 0) return;
  const t = queue[n];
  if (!t) return;
  const el = spare();
  const key = streamKey(t);
  if (prefetchKey === key && el.dataset.key === key) return;
  prefetchKey = key;
  el.dataset.key = key;
  el.src = audioUrl(t);
  try { el.load(); } catch (_) {}
  getStream(t).catch(() => {});     // заодно прогреваем кэш ссылки на сервере
}

async function playList(list, i) {
  wave = null;
  queue = list.slice();
  prefetchKey = null;
  updateModeButtons();
  await playAt(i);
}

/* play() может прерваться (AbortError) из-за смены src/паузы — это не ошибка трека, пробуем ещё раз */
async function playWithRetry(token) {
  let last;
  for (let k = 0; k < 4; k++) {
    if (token !== loadToken) return;
    try { await audio.play(); return; } catch (e) {
      last = e;
      if (e.name === "NotAllowedError") throw e;
      await new Promise((r) => setTimeout(r, 250 * (k + 1)));
      if (k === 2 && audio.error) { audio.load(); }   // реально сломанный источник — перезагружаем
    }
  }
  throw last;
}

async function playAt(i) {
  if (i < 0 || i >= queue.length) return;
  qi = i;
  cur = queue[i];
  const token = ++loadToken;
  document.body.classList.add("has-player");
  $("#mini").hidden = false;
  renderNowPlaying();
  markPlaying();
  updateMediaSession();
  if (wave && queue.length - qi <= 2) topUpWave();
  if (viewKind === "wave") renderWaveList();

  const el = spare();
  const key = streamKey(cur);
  const prepared = el.dataset.key === key;   // следующий трек уже загружен заранее?

  const bg = document.hidden;   // экран выключен / приложение свёрнуто
  prefetchKey = null;       // следующий пересчитаем после старта
  if (bg) {
    // В фоне iOS разрешает продолжать только уже «живой» <audio>: меняем src у него же, без паузы
    audio.dataset.key = key; audio.src = audioUrl(cur);
  } else {
    audio.pause();          // глушим текущий звук
    swap();                 // активным становится подготовленный элемент
    audio.currentTime = 0;
    if (!prepared) { audio.dataset.key = key; audio.src = audioUrl(cur); }
  }

  try {
    await playWithRetry(token);
    if (token !== loadToken) return;
    resumeAudio();
    if (wave) fb("trackStarted", cur, 0);
    prefetchNext();
    showQinfo(cur);         // кодек/битрейт — отдельным запросом, старт не задерживает
  } catch (e) {
    if (token !== loadToken) return;
    if (e.name === "NotAllowedError") toast("Нажмите «Играть», чтобы начать");
    else { qinfoEl.textContent = "Не удалось воспроизвести: " + e.message; toast("Не удалось воспроизвести трек"); }
  }
}

/* Какой трек пойдёт следующим при текущем режиме (-1 — продолжения нет). */
function nextIndex() {
  if (wave) return qi + 1 < queue.length ? qi + 1 : -1;
  if (S.shuffle && queue.length > 1) {
    let n;
    do { n = Math.floor(Math.random() * queue.length); } while (n === qi);
    return n;
  }
  if (qi + 1 < queue.length) return qi + 1;
  if (S.repeat === "all") return 0;
  return -1;
}

async function advance({ auto = false, feedback = true } = {}) {
  if (!cur) return;
  if (wave) {
    if (feedback) fb(auto ? "trackFinished" : "skip", cur, auto ? (audio.duration || cur.duration) : audio.currentTime);
    if (qi + 1 >= queue.length) await topUpWave();
    if (qi + 1 < queue.length) return playAt(qi + 1);
    return;
  }
  if (auto && S.repeat === "one") { audio.currentTime = 0; return audio.play(); }
  const n = nextIndex();
  if (n >= 0) return playAt(n);
}

function renderNowPlaying() {
  if (!cur) return;
  $("#miniNp").innerHTML = `${coverImg(cur.cover)}
    <div class="t-info"><div class="t-title">${esc(cur.title)}</div><div class="t-sub">${esc(cur.artists)}</div></div>`;
  $("#sMeta").innerHTML = `
    <div class="t-info"><div class="t-title">${esc(cur.title)}</div><div class="t-sub">${artistLinks(cur)}</div></div>
    <button class="ib" data-dislike aria-label="Не нравится">${ic("dislike")}</button>
    ${heartBtn("track", cur.id)}`;
  $("#sCover").src = big(cur.cover);
  $("#sheetBg").style.backgroundImage = cur.cover ? `url("${big(cur.cover)}")` : "";
  $("#sheetKind").textContent = wave ? wave.name : "Сейчас играет";
  $("#dur").textContent = fmt(cur.duration);
  if (typeof lyrOpen !== "undefined" && lyrOpen) lyrLoad();
}

function markPlaying() {
  document.querySelectorAll(".row").forEach((r) => r.classList.toggle("playing", !!cur && r.dataset.id === cur.id));
}

async function dislikeCurrent() {
  if (!cur) return;
  if (!S.authorized) return toast("Для дизлайков нужен токен Яндекс Музыки");
  const t = cur;
  haptic("medium");
  setLiked("track", bare(t.id), false);
  fb("skip", t, audio.currentTime);
  api("dislike", { id: t.id, dislike: true })
    .then(() => toast("Больше не будем рекомендовать этот трек"))
    .catch((e) => toast("Не получилось: " + e.message));
  advance({ feedback: false });
}

/* ---------- Волна ---------- */
function topUpWave() {
  if (!wave) return Promise.resolve();
  if (wave.pending) return wave.pending;
  const w = wave, last = queue[queue.length - 1];
  w.pending = api(`wave/tracks?station=${encodeURIComponent(w.station)}` + (last ? `&queue=${encodeURIComponent(last.id)}` : ""))
    .then((r) => {
      if (wave !== w) return;
      w.batchId = r.batch_id || w.batchId;
      const have = new Set(queue.map((t) => t.id));
      queue.push(...r.tracks.filter((t) => !have.has(t.id)));
      if (viewKind === "wave") renderWaveList();
    })
    .catch((e) => toast("Волна: " + e.message))
    .finally(() => { w.pending = null; });
  return w.pending;
}

async function startWave(station, name) {
  if (!S.authorized) return toast("Для волны нужен токен Яндекс Музыки");
  toast(`Включаю: ${name}`);
  try {
    const r = await api("wave/tracks?station=" + encodeURIComponent(station));
    if (!r.tracks.length) return toast("Волна пока пуста, выберите другую станцию");
    wave = { station, name, batchId: r.batch_id, pending: null };
    queue = r.tracks;
    prefetchKey = null;
    updateModeButtons();
    fb("radioStarted", null, 0);
    await playAt(0);
  } catch (e) {
    hapticNote("error");
    toast("Волна: " + e.message);
  }
}

/* ---------- Кнопки плеера ---------- */
function updateModeButtons() {
  const off = !!wave;
  $("#shuffle").classList.toggle("on", S.shuffle && !off);
  $("#shuffle").classList.toggle("off", off);
  $("#repeat").classList.toggle("on", S.repeat !== "off" && !off);
  $("#repeat").classList.toggle("off", off);
  $("#repeat use").setAttribute("href", S.repeat === "one" ? "#i-repeat1" : "#i-repeat");
  document.querySelectorAll("[data-q]").forEach((b) => b.classList.toggle("on", b.dataset.q === S.quality));
}
$("#shuffle").onclick = () => { S.shuffle = !S.shuffle; store.set("ton.shuffle", S.shuffle ? "1" : "0"); haptic(); updateModeButtons(); };
$("#repeat").onclick = () => {
  S.repeat = { off: "all", all: "one", one: "off" }[S.repeat];
  store.set("ton.repeat", S.repeat);
  haptic();
  updateModeButtons();
};

function togglePlay() {
  if (!cur) return;
  haptic();
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}
$("#play").onclick = togglePlay;
$("#miniPlay").onclick = togglePlay;
$("#prev").onclick = () => { haptic(); if (audio.currentTime > 3 || qi <= 0) audio.currentTime = 0; else playAt(qi - 1); };
$("#next").onclick = () => { haptic(); advance(); };

function setPlayIcon(paused) {
  document.querySelectorAll("#play use, #miniPlay use").forEach((u) => u.setAttribute("href", paused ? "#i-play" : "#i-pause"));
  document.body.classList.toggle("paused", paused);
}
/* Слушатели вешаем на оба элемента; события неактивного (загружаемого заранее) игнорируем. */
audioEls.forEach((el) => {
  el.addEventListener("play", () => { if (el === audio && cur) setPlayIcon(false); });
  el.addEventListener("pause", () => { if (el === audio) setPlayIcon(true); });
  el.addEventListener("ended", () => {
    if (el !== audio || !cur) return;
    setPlayIcon(true);
    advance({ auto: true });
  });
  el.addEventListener("loadedmetadata", () => { if (el === audio && cur) $("#dur").textContent = fmt(el.duration); });
  el.addEventListener("timeupdate", () => {
    if (el !== audio || !cur || !el.duration) return;
    const p = (el.currentTime / el.duration) * 100;
    $("#miniBar").style.width = p + "%";
    if (seeking) return;
    $("#cur").textContent = fmt(el.currentTime);
    $("#seek").value = p * 10;
    $("#seek").style.setProperty("--p", p + "%");
  });
});
$("#seek").addEventListener("input", (e) => {
  seeking = true;
  const v = e.target.value / 10;
  e.target.style.setProperty("--p", v + "%");
  if (audio.duration) $("#cur").textContent = fmt((v / 100) * audio.duration);
});
$("#seek").addEventListener("change", (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
  seeking = false;
});

/* Качество звука: переключаем на лету, оставаясь на той же секунде. */
document.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", async () => {
  S.quality = b.dataset.q;
  store.set("ton.quality", S.quality);
  updateModeButtons();
  prefetchKey = null;
  if (!cur || !audio.src) return;
  const pos = audio.currentTime, playing = !audio.paused, token = ++loadToken;
  audio.dataset.key = streamKey(cur);
  audio.src = audioUrl(cur);
  audio.addEventListener("loadedmetadata", () => { audio.currentTime = pos; }, { once: true });
  try {
    if (playing) await audio.play();
    resumeAudio();
    showQinfo(cur);
    prefetchNext();
  } catch (err) { qinfoEl.textContent = "Не удалось сменить качество: " + err.message; }
}));

/* Эквалайзер удалён */
const actx = null;
function ensureEq() {}
function resumeAudio() {}

/* Экран блокировки, Пункт управления и работа при выключенном экране */
const msOK = "mediaSession" in navigator;
function updateMediaSession() {
  if (!msOK || !cur) return;
  try {
    const c = cur.cover ? big(cur.cover) : "";
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.title, artist: cur.artists, album: (cur.album && cur.album.title) || "",
      artwork: c ? [96, 192, 256, 384, 512].map((n) => ({ src: c, sizes: n + "x" + n, type: "image/jpeg" })) : [],
    });
  } catch (_) {}
}
let lastPos = 0;
function updatePosition() {
  if (!msOK || !audio.duration || !isFinite(audio.duration)) return;
  const now = Date.now();
  if (now - lastPos < 1000) return;
  lastPos = now;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) }); } catch (_) {}
}
function setMs(action, fn) { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {} }
if (msOK) {
  setMs("play", () => audio.play().catch(() => {}));
  setMs("pause", () => audio.pause());
  setMs("previoustrack", () => $("#prev").click());
  setMs("nexttrack", () => advance());
  setMs("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); });
  setMs("seekforward", (d) => { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + ((d && d.seekOffset) || 10)); });
  setMs("seekto", (d) => { if (d && d.seekTime != null) audio.currentTime = d.seekTime; });
  audioEls.forEach((el) => {
    el.addEventListener("play", () => { if (el === audio) navigator.mediaSession.playbackState = "playing"; });
    el.addEventListener("pause", () => { if (el === audio) navigator.mediaSession.playbackState = "paused"; });
    el.addEventListener("timeupdate", () => { if (el === audio) updatePosition(); });
    el.addEventListener("loadedmetadata", () => { if (el === audio) { lastPos = 0; updatePosition(); } });
  });
}

/* ---------- Текст песни ---------- */
const lyrCache = new Map();
let lyrOpen = false, lyrData = null, lyrActive = -1, lyrFor = null;
function lyrRender(d) {
  const b = $("#lyricsBody");
  lyrData = d; lyrActive = -1;
  if (d.synced) {
    b.innerHTML = `<div class="lyr-pad"></div>` + d.lines.map((l, i) => `<p class="lyr-line" data-i="${i}" data-t="${l.t}">${esc(l.s) || "♪"}</p>`).join("") + `<div class="lyr-pad"></div>`;
  } else if (d.text) {
    b.innerHTML = `<div class="lyr-plain">${d.text.split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
  } else {
    b.innerHTML = `<div class="msg">${ic("music")}<br>Для этого трека текста нет</div>`;
  }
  b.scrollTop = 0;
  lyrSync(true);
}
async function lyrLoad() {
  if (!cur) return;
  const t = cur;
  lyrFor = t.id;
  $("#lyricsTitle").innerHTML = `<b>${esc(t.title)}</b><span>${esc(t.artists)}</span>`;
  if (lyrCache.has(t.id)) return lyrRender(lyrCache.get(t.id));
  $("#lyricsBody").innerHTML = `<div class="skel" style="padding:8px 4px">${"<div class=\"skel-row\" style=\"min-height:44px;grid-template-columns:1fr\"><b><u style=\"width:80%\"></u></b></div>".repeat(7)}</div>`;
  try {
    const d = await api("lyrics/" + encodeURIComponent(t.id));
    lyrCache.set(t.id, d);
    if (lyrFor === t.id) lyrRender(d);
  } catch (e) {
    if (lyrFor === t.id) $("#lyricsBody").innerHTML = `<div class="msg err">Не удалось загрузить текст</div>`;
  }
}
function lyrSync(force) {
  if (!lyrOpen || !lyrData || !lyrData.synced) return;
  const now = audio.currentTime + 0.25;
  let idx = -1;
  for (let i = 0; i < lyrData.lines.length; i++) { if (lyrData.lines[i].t <= now) idx = i; else break; }
  if (idx === lyrActive && !force) return;
  lyrActive = idx;
  const els = $("#lyricsBody").querySelectorAll(".lyr-line");
  els.forEach((el, i) => { el.classList.toggle("on", i === idx); el.classList.toggle("past", i < idx); });
  if (idx >= 0 && els[idx]) els[idx].scrollIntoView({ block: "center", behavior: force ? "auto" : "smooth" });
}
function openLyrics() { if (!cur) return; haptic(); lyrOpen = true; $("#lyrics").classList.add("open"); $("#lyrics").setAttribute("aria-hidden", "false"); lyrLoad(); }
function closeLyrics() { lyrOpen = false; $("#lyrics").classList.remove("open"); $("#lyrics").setAttribute("aria-hidden", "true"); }
$("#lyricsBtn").onclick = openLyrics;
$("#lyricsClose").onclick = closeLyrics;
$("#lyricsBody").addEventListener("click", (e) => {
  const p = e.target.closest(".lyr-line");
  if (p) { haptic(); audio.currentTime = +p.dataset.t; }
});
audioEls.forEach((el) => el.addEventListener("timeupdate", () => { if (el === audio) lyrSync(false); }));

/* ---------- Полноэкранный плеер и кнопка «Назад» ---------- */
const sheetOpen = () => $("#sheet").classList.contains("open");
function openSheet() {
  if (!cur) return;
  haptic();
  $("#sheet").classList.add("open");
  $("#sheet").setAttribute("aria-hidden", "false");
  syncBack();
}
function closeSheet() {
  closeLyrics();
  $("#sheet").classList.remove("open");
  $("#sheet").setAttribute("aria-hidden", "true");
  syncBack();
}
$("#miniOpen").addEventListener("click", openSheet);
$("#miniOpen").addEventListener("keydown", (e) => { if (e.key === "Enter") openSheet(); });
$("#sheetClose").addEventListener("click", closeSheet);

const isRoot = () => {
  const p = location.hash.replace(/^#\/?/, "").split("/");
  return !p[0] || p[0] === "wave" || p[0] === "my" || (p[0] === "search" && !p[1]);
};
function goBack() {
  if (sheetOpen()) return closeSheet();
  if (!isRoot()) history.length > 1 ? history.back() : (location.hash = "#/");
}
function syncBack() {
  const show = sheetOpen() || !isRoot();
  try { show ? tg.BackButton.show() : tg.BackButton.hide(); } catch (_) {}
  if (!inTg) $("#back").hidden = !show || sheetOpen();
}
try { tg.BackButton.onClick(goBack); } catch (_) {}
$("#back").addEventListener("click", goBack);

/* ---------- Отрисовка списков ---------- */
function tracksHtml(list, { showAlbum = true } = {}) {
  if (!list.length) return `<div class="msg">Здесь пока пусто</div>`;
  return `<div class="tracks">` + list.map((t, i) => `
    <div class="row${cur && cur.id === t.id ? " playing" : ""}" data-i="${i}" data-id="${esc(t.id)}">
      ${coverImg(t.cover)}
      <div class="t-info">
        <div class="t-title">${esc(t.title)}</div>
        <div class="t-sub">${artistLinks(t)}${showAlbum && t.album ? `, <a class="lnk" href="#/album/${esc(t.album.id)}">${esc(t.album.title)}</a>` : ""}</div>
      </div>
      ${heartBtn("track", t.id)}
      <div class="t-time">${fmt(t.duration)}</div>
    </div>`).join("") + `</div>`;
}

const albumKind = (t) => ({ single: "Сингл", compilation: "Сборник", podcast: "Подкаст" }[t] || "Альбом");

const albumsHtml = (albums) => !albums.length ? `<div class="msg">Альбомов нет</div>` :
  `<div class="grid">` + albums.map((a) => `
    <a class="card" href="#/album/${esc(a.id)}">${coverImg(a.cover)}
      <div class="c-title">${esc(a.title)}</div>
      <div class="c-sub">${esc([a.year, albumKind(a.type)].filter(Boolean).join(", "))}</div>
    </a>`).join("") + `</div>`;

const artistsHtml = (list) => !list.length ? `<div class="msg">Здесь пока пусто</div>` :
  `<div class="grid">` + list.map((a) => `
    <a class="card round" href="#/artist/${esc(a.id)}">${coverImg(a.cover)}
      <div class="c-title">${esc(a.name)}</div><div class="c-sub">Исполнитель</div>
    </a>`).join("") + `</div>`;

/* Клики: всё в одном месте */
document.addEventListener("click", (e) => {
  const like = e.target.closest("[data-like]");
  if (like) { toggleLike(like.dataset.like, like.dataset.id); return; }
  if (e.target.closest("[data-dislike]")) { dislikeCurrent(); return; }
  const w = e.target.closest("[data-wave]");
  if (w) {
    haptic();
    startWave(w.dataset.wave, w.dataset.name).then(() => { if (viewKind === "wave") pageWave(); });
    return;
  }
  if (e.target.closest("#sMeta a")) { closeSheet(); return; }
  if (e.target.closest("[data-play]")) { if (viewTracks.length) { haptic(); playList(viewTracks, 0); } return; }
  if (e.target.closest("a, button, input")) return;
  const row = e.target.closest("#view .row");
  if (row) {
    haptic();
    const i = +row.dataset.i;
    viewKind === "wave" && wave ? playAt(i) : playList(viewTracks, i);
  }
});

const setView = (html) => { $("#view").innerHTML = html; };
const loading = () => setView(`<div class="skel">${"<div class=\"skel-row\"><i></i><b><u></u><u></u></b></div>".repeat(9)}</div>`);
const failed = (e) => setView(`<div class="msg err">${esc(e.message)}</div>`);
const needToken = (what) => setView(`<div class="msg">${ic("lock")}<br>${what} нужен вход в Яндекс Музыку.</div>`);

/* ---------- Страницы ---------- */
const myTabs = (active) => `<div class="chips">` + [["", "Треки"], ["artists", "Исполнители"], ["albums", "Альбомы"]]
  .map(([k, label]) => `<a class="chip ${active === k ? "on" : ""}" href="#/${k ? "my/" + k : ""}">${label}</a>`).join("") + `</div>`;

async function pageLikes() {
  viewTracks = [];
  if (!S.authorized) return needToken("Чтобы видеть любимое,");
  loading();
  try { viewTracks = await api("likes"); setView(myTabs("") + tracksHtml(viewTracks)); } catch (e) { failed(e); }
}
async function pageMyArtists() {
  viewTracks = [];
  if (!S.authorized) return needToken("Чтобы видеть любимое,");
  loading();
  try { setView(myTabs("artists") + artistsHtml(await api("likes/artists"))); } catch (e) { failed(e); }
}
async function pageMyAlbums() {
  viewTracks = [];
  if (!S.authorized) return needToken("Чтобы видеть любимое,");
  loading();
  try { setView(myTabs("albums") + albumsHtml(await api("likes/albums"))); } catch (e) { failed(e); }
}

const searchForm = (q) => `<form class="searchbox" id="sf" role="search">${ic("search")}
  <input id="q" type="search" enterkeyhint="search" placeholder="Трек или исполнитель" autocomplete="off" autocapitalize="off" value="${esc(q)}"></form>`;

async function pageSearch(q) {
  viewTracks = [];
  if (!q) {
    setView(searchForm("") + `<div class="msg">${ic("music")}<br>Найдите трек или исполнителя</div>`);
    if (!inTg || tg.platform === "tdesktop") $("#q").focus();
    return;
  }
  setView(searchForm(q) + `<div class="msg">Ищу</div>`);
  try {
    const [tracks, artists] = await Promise.all([
      api("search?q=" + encodeURIComponent(q)),
      api("search/artists?q=" + encodeURIComponent(q)).catch(() => []),
    ]);
    viewTracks = tracks;
    let html = searchForm(q);
    if (artists.length) html += `<h2>Исполнители</h2>` + artistsHtml(artists.slice(0, 6));
    html += `<h2>Треки</h2>` + tracksHtml(tracks);
    setView(html);
  } catch (e) { setView(searchForm(q) + `<div class="msg err">${esc(e.message)}</div>`); }
}
document.addEventListener("submit", (e) => {
  if (e.target.id !== "sf") return;
  e.preventDefault();
  const q = $("#q").value.trim();
  $("#q").blur();
  if (q) location.hash = "#/search/" + encodeURIComponent(q);
});

async function pageArtist(id) {
  loading();
  try {
    const [data, albums] = await Promise.all([
      api("artist/" + encodeURIComponent(id)),
      api("artist/" + encodeURIComponent(id) + "/albums").catch(() => []),
    ]);
    const a = data.artist;
    viewTracks = data.popular_tracks;
    const meta = [a.likes ? a.likes.toLocaleString("ru-RU") + " лайков" : "", (a.genres || []).slice(0, 3).join(", ")].filter(Boolean).join(", ");
    setView(`
      <div class="hero artist">
        ${coverImg(a.cover)}
        <div>
          <div class="kind">Исполнитель</div>
          <h1>${esc(a.name)}</h1>
          <div class="meta">${esc(meta)}</div>
          <div class="actions">
            <button class="btn" data-play>${ic("play", "fill")}Слушать</button>
            ${S.authorized ? `<button class="btn ghost" data-wave="artist:${esc(a.id)}" data-name="Радио: ${esc(a.name)}">${ic("wave")}Радио</button>` : ""}
            ${heartBtn("artist", a.id, "big")}
          </div>
        </div>
      </div>
      <h2>Популярные треки</h2>${tracksHtml(viewTracks)}
      <h2>Альбомы</h2>${albumsHtml(albums)}`);
  } catch (e) { failed(e); }
}

async function pageAlbum(id) {
  loading();
  try {
    const data = await api("album/" + encodeURIComponent(id));
    const a = data.album;
    viewTracks = data.tracks;
    const total = viewTracks.reduce((s, t) => s + t.duration, 0);
    setView(`
      <div class="hero">
        ${coverImg(big(a.cover))}
        <div>
          <div class="kind">${esc(albumKind(a.type))}</div>
          <h1>${esc(a.title)}</h1>
          <div class="meta">${artistLinks(a)}${a.year ? ", " + esc(a.year) : ""}<br>${viewTracks.length} треков, ${fmt(total)}</div>
          <div class="actions">
            <button class="btn" data-play>${ic("play", "fill")}Слушать</button>
            ${heartBtn("album", a.id, "big")}
          </div>
        </div>
      </div>
      <h2>Треки</h2>${tracksHtml(viewTracks, { showAlbum: false })}`);
  } catch (e) { failed(e); }
}

let stationsCache = null;
function renderWaveList() {
  const el = $("#wlist");
  if (!el) return;
  viewTracks = wave ? queue : [];
  el.innerHTML = wave ? tracksHtml(queue) : `<div class="msg">Выберите станцию, и музыка начнётся</div>`;
}

async function pageWave() {
  viewKind = "wave";
  viewTracks = [];
  if (!S.authorized) return needToken("Для «Моей волны»");
  if (!stationsCache) {
    loading();
    try { stationsCache = await api("wave/stations"); } catch (e) { return failed(e); }
  }
  const groups = {};
  stationsCache.forEach((s) => { (groups[s.group] = groups[s.group] || []).push(s); });
  const chip = (s) => `<button class="chip ${wave && wave.station === s.id ? "on" : ""}" data-wave="${esc(s.id)}" data-name="${esc(s.name)}">${esc(s.name)}</button>`;
  const chips = Object.entries(groups).filter(([g]) => g)
    .map(([g, list]) => `<h2>${esc(g)}</h2><div class="chips wrap">${list.map(chip).join("")}</div>`).join("");
  const isMain = wave && wave.station === "user:onyourwave";
  setView(`
    <div class="hero">
      <div class="wave-orb ${wave ? "" : "idle"}" aria-hidden="true"></div>
      <div>
        <h1>${esc(wave ? wave.name : "Моя волна")}</h1>
        <div class="meta">Музыка подстраивается под вас: лайки, дизлайки и пропуски делают волну точнее.</div>
        <div class="actions">
          <button class="btn" data-wave="user:onyourwave" data-name="Моя волна">${ic(isMain ? "refresh" : "play", isMain ? "" : "fill")}${isMain ? "Перезапустить" : "Включить"}</button>
        </div>
      </div>
    </div>
    ${chips}
    <h2>В очереди</h2><div id="wlist"></div>`);
  renderWaveList();
}

/* ---------- Роутинг по hash: работает системная кнопка «Назад» ---------- */
function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  viewKind = null;
  const tab = { wave: "wave", search: "search", my: "my", "": "my" }[parts[0]];
  if (tab) document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.id === "tab-" + tab));
  closeSheet();
  syncBack();
  window.scrollTo(0, 0);
  switch (parts[0]) {
    case "artist": return pageArtist(parts[1]);
    case "album": return pageAlbum(parts[1]);
    case "search": return pageSearch(parts.slice(1).join("/"));
    case "wave": return pageWave();
    case "my": return parts[1] === "albums" ? pageMyAlbums() : pageMyArtists();
    default: return pageLikes();
  }
}
window.addEventListener("hashchange", route);

/* ---------- Запуск ---------- */
const bootEl = $("#boot");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hideBoot() {
  document.body.classList.remove("booting");
  if (!bootEl || !bootEl.isConnected) return;
  bootEl.classList.add("out");
  setTimeout(() => bootEl.remove(), 600);
}
async function retry(fn, n = 3) {
  let last;
  for (let k = 0; k < n; k++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (/Telegram|BOT_TOKEN|доступ/i.test(e.message)) throw e;
      await sleep(400 * (k + 1));
    }
  }
  throw last;
}
// Лайки грузим в фоне: они медленные, а интерфейсу нужны только для сердечек
function loadLikes() {
  retry(() => api("likes/ids")).then((l) => {
    for (const k of ["track", "artist", "album"]) S.liked[k] = new Set((l[k + "s"] || []).map(String));
    ["track", "artist", "album"].forEach((k) => document.querySelectorAll(`[data-like="${k}"]`).forEach((el) => {
      el.classList.toggle("on", S.liked[k].has(el.dataset.bare));
    }));
  }).catch(() => {});
}
async function init() {
  const t0 = performance.now();
  updateModeButtons();
  let fatal = null;
  const cached = store.get("ton.auth");
  if (cached != null) S.authorized = cached === "1";   // знаем с прошлого раза — не ждём сеть
  const check = retry(() => api("auth")).then((a) => { S.authorized = !!a.authorized; store.set("ton.auth", a.authorized ? "1" : "0"); });
  if (cached == null) { try { await check; } catch (e) { fatal = e; } } else { check.catch(() => {}); }
  api("status").then((s) => {
    $("#who").textContent = s.authorized ? "" : "без входа, отрывки по 30 с";
  }).catch(() => {});
  if (fatal && /Telegram|BOT_TOKEN|доступ/i.test(fatal.message)) {
    setView(`<div class="msg err">${ic("lock")}<br>${esc(fatal.message)}</div>`);
  } else if (fatal) {
    setView(`<div class="msg err">Не удалось подключиться.<br><button class="btn" id="retry" style="margin-top:16px">Повторить</button></div>`);
    $("#retry").onclick = () => location.reload();
  } else {
    route();           // не ждём данные страницы: сразу скелетоны
    loadLikes();
  }
  const left = 450 - (performance.now() - t0);
  if (left > 0) await sleep(left);
  hideBoot();
}
init();
setTimeout(hideBoot, 8000);   // страховка
