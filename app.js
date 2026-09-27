(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- 설정 ----------
  const SETTINGS_KEY = 'tt.settings';
  const HISTORY_KEY = 'tt.history';
  const settings = Object.assign(
    { face: true, autoSpeak: true, live: true, accent: 'en-US', rate: 1, wake: true },
    load(SETTINGS_KEY, {})
  );

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 환경 무시 */ }
  }

  // side: 'me' = 한국어 화자, 'them' = 영어 화자
  const SIDES = {
    me:   { lang: 'ko', speech: () => 'ko-KR', other: 'them' },
    them: { lang: 'en', speech: () => settings.accent, other: 'me' },
  };
  const ui = {
    me:   { panel: $('panelMe'),   main: $('mainMe'),   sub: $('subMe'),   status: $('statusMe'),   mic: $('micMe') },
    them: { panel: $('panelThem'), main: $('mainThem'), sub: $('subThem'), status: $('statusThem'), mic: $('micThem') },
  };
  const PLACEHOLDER = {
    me: '마이크를 누르고 한국어로 말하세요.',
    them: 'Tap the mic and speak English.',
  };
  // 각 패널에 마지막으로 표시된(읽어줄) 문장
  const lastSpoken = { me: null, them: null };

  // ---------- 번역 ----------
  const cache = new Map();

  async function translate(text, from, to, signal) {
    const key = `${from}|${to}|${text}`;
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      result = await translateGoogle(text, from, to, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      result = await translateMyMemory(text, from, to, signal);
    }
    cache.set(key, result);
    return result;
  }

  async function translateGoogle(text, from, to, signal) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
      + `&sl=${from}&tl=${to}&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`google ${res.status}`);
    const data = await res.json();
    const out = (data[0] || []).map((seg) => seg[0]).join('').trim();
    if (!out) throw new Error('google empty');
    return out;
  }

  async function translateMyMemory(text, from, to, signal) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`mymemory ${res.status}`);
    const data = await res.json();
    const out = data?.responseData?.translatedText?.trim();
    if (!out) throw new Error('mymemory empty');
    return out;
  }

  // ---------- 음성 출력 ----------
  const synth = window.speechSynthesis;
  let voices = [];
  function loadVoices() { voices = synth ? synth.getVoices() : []; }
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

  function pickVoice(lang) {
    const exact = voices.filter((v) => v.lang.replace('_', '-') === lang);
    const loose = exact.length ? exact : voices.filter((v) => v.lang.startsWith(lang.slice(0, 2)));
    return loose.find((v) => /Google|Siri|Premium|Enhanced|Natural/i.test(v.name)) || loose[0] || null;
  }

  function speak(text, lang) {
    if (!synth || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = settings.rate;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    synth.speak(u);
  }

  // iOS는 사용자 제스처 안에서 한 번 말해야 이후 자동 재생이 허용됨
  let ttsUnlocked = false;
  function unlockTTS() {
    if (ttsUnlocked || !synth) return;
    ttsUnlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  }

  // ---------- 음성 인식 ----------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let activeSide = null;
  let finalText = '';
  let liveTimer = null;
  let liveAbort = null;
  let finalizing = false;

  function startListening(side) {
    if (!Recognition) {
      toast('이 브라우저는 음성 인식을 지원하지 않아요.\nChrome 또는 Safari를 사용하거나 ⌨️ 입력을 이용하세요.');
      return;
    }
    if (activeSide) { stopListening(); return; }
    if (synth) synth.cancel(); // 스피커 소리가 마이크로 들어가지 않게

    activeSide = side;
    finalText = '';
    finalizing = false;
    rec = new Recognition();
    rec.lang = SIDES[side].speech();
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => setListeningUI(side, true);
    rec.onresult = (e) => {
      let interim = '';
      finalText = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      const shown = (finalText + interim).trim();
      showSource(side, shown, !!interim);
      if (settings.live && interim) scheduleLive(side, shown);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('마이크 권한이 필요해요. 브라우저 설정에서 마이크를 허용해 주세요.');
      } else if (e.error === 'no-speech') {
        toast(side === 'me' ? '음성이 들리지 않았어요.' : "I didn't hear anything.");
      } else if (e.error === 'network') {
        toast('음성 인식에 인터넷 연결이 필요해요.');
      } else if (e.error !== 'aborted') {
        toast(`음성 인식 오류: ${e.error}`);
      }
    };
    rec.onend = () => {
      setListeningUI(side, false);
      activeSide = null;
      rec = null;
      finalize(side, finalText.trim());
    };

    try { rec.start(); } catch (err) {
      activeSide = null;
      rec = null;
      toast('마이크를 시작할 수 없어요. 잠시 후 다시 시도해 주세요.');
    }
  }

  function stopListening() {
    if (rec) rec.stop();
  }

  function scheduleLive(side, text) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
      if (finalizing) return;
      liveAbort?.abort();
      liveAbort = new AbortController();
      const other = SIDES[side].other;
      try {
        const out = await translate(text, SIDES[side].lang, SIDES[other].lang, liveAbort.signal);
        if (!finalizing) showTarget(other, out, text, true);
      } catch { /* 중간 번역 실패는 무시 */ }
    }, 350);
  }

  async function finalize(side, text) {
    finalizing = true;
    clearTimeout(liveTimer);
    liveAbort?.abort();
    if (!text) {
      if (ui[side].main.classList.contains('interim')) resetPanel(side);
      return;
    }
    showSource(side, text, false);
    await runTranslation(side, text);
  }

  // ---------- 공통 번역 흐름 ----------
  async function runTranslation(side, text) {
    const other = SIDES[side].other;
    ui[other].status.textContent = other === 'me' ? '번역 중…' : 'Translating…';
    try {
      const out = await translate(text, SIDES[side].lang, SIDES[other].lang);
      showTarget(other, out, text, false);
      lastSpoken[other] = out;
      addHistory(side, text, out);
      if (settings.autoSpeak) speak(out, SIDES[other].speech());
    } catch {
      ui[other].status.textContent = '';
      toast('번역에 실패했어요. 인터넷 연결을 확인하거나 📖 여행 회화를 이용하세요.');
    }
  }

  // ---------- 화면 표시 ----------
  function showSource(side, text, interim) {
    const u = ui[side];
    u.main.textContent = text || '…';
    u.main.classList.remove('placeholder');
    u.main.classList.toggle('interim', interim);
    u.sub.textContent = '';
  }

  function showTarget(side, translated, original, interim) {
    const u = ui[side];
    u.main.textContent = translated;
    u.main.classList.remove('placeholder');
    u.main.classList.toggle('interim', interim);
    u.sub.textContent = original;
    u.status.textContent = interim ? (side === 'me' ? '듣는 중…' : 'Listening…') : '';
  }

  function resetPanel(side) {
    const u = ui[side];
    u.main.textContent = PLACEHOLDER[side];
    u.main.className = 'main-text placeholder';
    u.sub.textContent = '';
    u.status.textContent = '';
    lastSpoken[side] = null;
  }

  function setListeningUI(side, on) {
    const u = ui[side];
    u.panel.classList.toggle('listening', on);
    u.mic.classList.toggle('on', on);
    u.mic.querySelector('.mic-label').textContent = on
      ? (side === 'me' ? '듣는 중' : 'Listening')
      : (side === 'me' ? '말하기' : 'Speak');
    u.status.textContent = on ? (side === 'me' ? '듣는 중…' : 'Listening…') : '';
    if (on) showSource(side, '', true);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.style.whiteSpace = 'pre-line';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ---------- 기록 ----------
  let history = load(HISTORY_KEY, []);

  function addHistory(side, src, dst) {
    history.unshift({ side, src, dst, at: Date.now() });
    history = history.slice(0, 200);
    save(HISTORY_KEY, history);
  }

  function renderHistory() {
    const list = $('historyList');
    list.innerHTML = '';
    if (!history.length) {
      list.innerHTML = '<li class="empty">아직 대화 기록이 없어요</li>';
      return;
    }
    for (const h of history) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = h.side === 'me' ? '🇰🇷' : '🇺🇸';
      const txt = document.createElement('div');
      txt.className = 'txt';
      txt.innerHTML = '<div class="src"></div><div class="dst"></div><div class="time"></div>';
      txt.querySelector('.src').textContent = h.src;
      txt.querySelector('.dst').textContent = h.dst;
      txt.querySelector('.time').textContent = new Date(h.at).toLocaleString('ko-KR', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const play = document.createElement('button');
      play.className = 'play';
      play.textContent = '🔊';
      play.setAttribute('aria-label', '다시 듣기');
      play.onclick = () => speak(h.dst, SIDES[SIDES[h.side].other].speech());
      li.append(who, txt, play);
      list.append(li);
    }
  }

  // ---------- 여행 회화 ----------
  let currentCat = Object.keys(window.PHRASES)[0];

  function renderPhrases() {
    const cats = $('phraseCats');
    cats.innerHTML = '';
    for (const cat of Object.keys(window.PHRASES)) {
      const b = document.createElement('button');
      b.className = 'chip' + (cat === currentCat ? ' active' : '');
      b.textContent = cat;
      b.onclick = () => { currentCat = cat; renderPhrases(); };
      cats.append(b);
    }
    const list = $('phraseList');
    list.innerHTML = '';
    for (const [ko, en] of window.PHRASES[currentCat]) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = '<span class="ko"></span><span class="en"></span>';
      b.querySelector('.ko').textContent = ko;
      b.querySelector('.en').textContent = en;
      b.onclick = () => {
        unlockTTS();
        showSource('me', ko, false);
        showTarget('them', en, ko, false);
        lastSpoken.them = en;
        addHistory('me', ko, en);
        speak(en, SIDES.them.speech());
        closeSheets();
      };
      li.append(b);
      list.append(li);
    }
  }

  // ---------- 텍스트 입력 ----------
  let typeDir = 'me';
  document.querySelectorAll('.dir').forEach((b) => {
    b.onclick = () => {
      typeDir = b.dataset.dir;
      document.querySelectorAll('.dir').forEach((x) => x.classList.toggle('active', x === b));
      $('typeInput').placeholder = typeDir === 'me' ? '번역할 문장을 입력하세요' : 'Type in English';
    };
  });
  $('typeGo').onclick = () => {
    const text = $('typeInput').value.trim();
    if (!text) return;
    unlockTTS();
    closeSheets();
    showSource(typeDir, text, false);
    runTranslation(typeDir, text);
    $('typeInput').value = '';
  };

  // ---------- 바텀시트 ----------
  const sheets = {
    btnPhrases: ['sheetPhrases', renderPhrases],
    btnType: ['sheetType', () => setTimeout(() => $('typeInput').focus(), 50)],
    btnHistory: ['sheetHistory', renderHistory],
    btnSettings: ['sheetSettings', null],
  };
  for (const [btn, [sheet, onOpen]] of Object.entries(sheets)) {
    $(btn).onclick = () => {
      if (activeSide) stopListening();
      closeSheets();
      $(sheet).hidden = false;
      $('backdrop').hidden = false;
      onOpen?.();
    };
  }
  function closeSheets() {
    document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
    $('backdrop').hidden = true;
  }
  $('backdrop').onclick = closeSheets;
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeSheets; });

  $('historyClear').onclick = () => {
    if (!confirm('대화 기록을 모두 삭제할까요?')) return;
    history = [];
    save(HISTORY_KEY, history);
    renderHistory();
  };

  // ---------- 설정 UI ----------
  const opt = {
    face: $('optFace'), autoSpeak: $('optAutoSpeak'), live: $('optLive'),
    accent: $('optAccent'), rate: $('optRate'), wake: $('optWake'),
  };
  opt.face.checked = settings.face;
  opt.autoSpeak.checked = settings.autoSpeak;
  opt.live.checked = settings.live;
  opt.accent.value = settings.accent;
  opt.rate.value = settings.rate;
  opt.wake.checked = settings.wake;

  function applySettings() {
    $('app').classList.toggle('face-to-face', settings.face);
    $('rateVal').textContent = Number(settings.rate).toFixed(1);
    updateWakeLock();
  }
  for (const [k, el] of Object.entries(opt)) {
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      settings[k] = el.type === 'checkbox' ? el.checked : (el.type === 'range' ? Number(el.value) : el.value);
      save(SETTINGS_KEY, settings);
      applySettings();
    });
  }

  // ---------- 화면 켜짐 유지 ----------
  let wakeLock = null;
  async function updateWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      if (settings.wake && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!settings.wake && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { /* 권한 없음 등 무시 */ }
  }
  document.addEventListener('visibilitychange', updateWakeLock);

  // ---------- 버튼 연결 ----------
  for (const side of ['me', 'them']) {
    ui[side].mic.onclick = () => { unlockTTS(); startListening(side); };
  }
  document.querySelectorAll('[data-replay]').forEach((b) => {
    b.onclick = () => {
      const side = b.dataset.replay;
      unlockTTS();
      if (lastSpoken[side]) speak(lastSpoken[side], SIDES[side].speech());
      else toast(side === 'me' ? '다시 들을 번역이 없어요.' : 'Nothing to replay yet.');
    };
  });
  document.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => { resetPanel('me'); resetPanel('them'); };
  });

  resetPanel('me');
  resetPanel('them');
  applySettings();

  if (!Recognition) {
    ui.me.sub.textContent = '이 브라우저는 음성 인식을 지원하지 않아요. ⌨️ 입력을 이용하세요.';
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
