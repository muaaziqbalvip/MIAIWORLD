// ════════════════════════════════════════════════════════════════════════════════
// MI AI — LIVE AI CALL SYSTEM v5.0 (WEBVIEW-COMPATIBLE — WebRTC + Groq Whisper STT)
// By Muaaz Iqbal | Muslim Islam Org
//
// WHY THIS REWRITE EXISTS:
// The old engine used window.SpeechRecognition / webkitSpeechRecognition.
// That API does NOT exist inside Android WebView (only in real Chrome/desktop).
// So inside the MI AI Android app, the mic never worked — no permission issue,
// the API itself was simply unavailable.
//
// FIX: Replace SpeechRecognition entirely with:
//   navigator.mediaDevices.getUserMedia({ audio:true }) + MediaRecorder
//   -> records short audio chunks
//   -> sends them to Groq Whisper (whisper-large-v3) for transcription
//   -> same silence-detection comfort logic decides when to stop recording
// This works identically in WebView, Chrome, and any modern browser.
//
// EVERYTHING ELSE (UI, language picker, wave animation, TTS, auto-disconnect
// keywords, mute button, call summary) is preserved exactly as before.
// ════════════════════════════════════════════════════════════════════════════════

// ── GROQ WHISPER CONFIG (multi-key rotation lives here) ──
// Replace these placeholder keys with your real Groq keys (same ones used in
// groq_rotator.py / app.js). Add as many as you want — rotation is automatic.
const GROQ_WHISPER_KEYS = [
  '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',
  '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',
  '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'
];
let _groqKeyIndex = 0;
const _groqKeyCooldown = {}; // key -> timestamp until which it's cooling down

function getNextGroqKey() {
  const now = Date.now();
  for (let i = 0; i < GROQ_WHISPER_KEYS.length; i++) {
    const idx = (_groqKeyIndex + i) % GROQ_WHISPER_KEYS.length;
    const key = GROQ_WHISPER_KEYS[idx];
    if (!_groqKeyCooldown[key] || _groqKeyCooldown[key] < now) {
      _groqKeyIndex = (idx + 1) % GROQ_WHISPER_KEYS.length;
      return key;
    }
  }
  // All keys cooling down — just return the first one anyway (best effort)
  return GROQ_WHISPER_KEYS[0];
}

function cooldownGroqKey(key, ms = 60000) {
  _groqKeyCooldown[key] = Date.now() + ms;
}

// ── GLOBAL CALL STATES (System ki halat track karne ke liye variables) ──
let callActive = false;      // Call chal rahi hai ya nahi
let callMuted = false;       // User ka microphone mute hai?
let callMediaStream = null;  // getUserMedia se mila audio stream
let callRecorder = null;     // MediaRecorder instance
let callSpeaking = false;    // Kya AI is waqt bol raha hai? (Mic off rakhne ke liye)
let callHistory = [];        // Call ke doran hone wali baaton ka record
let callLang = 'en-US';      // Default language English set hai
let callLangLabel = 'English';
let callListenGen = 0;       // Double/Triple mic start bugs ko block karne ka token
let callSilenceTimer = null; // User ki aawaz ke baad pause track karne ka timer
let callAudioChunks = [];    // Current recording ke audio chunks
let callAnalyser = null;     // Web Audio analyser for silence/voice detection
let callAudioCtx = null;     // AudioContext
let callVoiceDetectFrame = null; // requestAnimationFrame handle

// ════════════════════════════════════════════════════════════════════════════════
// 1. START CALL FUNCTION (UI Setup & Microphone Permissions)
// ════════════════════════════════════════════════════════════════════════════════
function startCall(lang, langLabel) {
  // MediaRecorder + getUserMedia check (works in WebView, unlike SpeechRecognition)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    if (typeof toast === 'function') toast('Voice calling needs microphone support in this browser/app', 'er');
    return;
  }

  // Agar language pass nahi ki gayi, to Language Picker Screen dikhao
  if (!lang) {
    const _ov = document.getElementById('call-overlay');
    _ov.classList.add('show');
    _ov.style.display = 'flex';

    _ov.innerHTML = `
      <div style="font-size:4.5rem;margin-bottom:15px;text-shadow: 0 0 20px var(--p)">🤖</div>
      <div style="font-size:1.6rem;font-weight:800;color:#fff;margin-bottom:8px">MI AI Live Call</div>
      <div style="font-size:0.9rem;color:var(--ts);margin-bottom:25px">Choose your preferred language / زبان منتخب کریں</div>

      <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;max-width:350px">
        <button onclick="startCall('en-US','English')" style="padding:14px 22px;border-radius:12px;background:var(--bgi);border:2px solid var(--p);color:var(--pl);font-size:1rem;cursor:pointer;font-family:var(--fm);font-weight:bold;transition:0.3s">🇬🇧 English</button>
        <button onclick="startCall('ur-PK','Urdu')" style="padding:14px 22px;border-radius:12px;background:var(--bgi);border:2px solid var(--gold);color:var(--gold);font-size:1rem;cursor:pointer;font-family:var(--fa);font-weight:bold;transition:0.3s">🇵🇰 اردو</button>
        <button onclick="startCall('ar-SA','Arabic')" style="padding:14px 22px;border-radius:12px;background:var(--bgi);border:2px solid var(--s);color:var(--s);font-size:1rem;cursor:pointer;font-family:var(--fa);font-weight:bold;transition:0.3s">🇸🇦 عربی</button>
        <button onclick="startCall('hi-IN','Hindi')" style="padding:14px 22px;border-radius:12px;background:var(--bgi);border:2px solid var(--ts);color:var(--ts);font-size:1rem;cursor:pointer;font-family:var(--fm);font-weight:bold;transition:0.3s">🇮🇳 Hindi</button>
      </div>

      <button onclick="endCall()" style="margin-top:25px;padding:12px 30px;border-radius:12px;background:#e74c3c;border:none;color:#fff;cursor:pointer;font-size:1rem;font-weight:bold;box-shadow: 0 4px 15px rgba(231,76,60,0.4)">❌ Cancel Call</button>
    `;
    return;
  }

  // State Variables Setup
  callLang = lang;
  callLangLabel = langLabel || 'English';
  callActive = true;
  callHistory = [];
  callMuted = false;
  callListenGen++; // Purane mic sessions ko kill karne ke liye ID update

  if (typeof pauseMusicForCall === 'function') pauseMusicForCall();

  // Main Call Screen UI Rendering (unchanged)
  const ov2 = document.getElementById('call-overlay');
  ov2.classList.add('show');
  ov2.style.display = 'flex';
  ov2.innerHTML = `
    <div class="call-avatar" id="call-avatar" style="font-size:4rem; transition: transform 0.3s ease;">🤖</div>
    <div class="call-name" style="font-size:1.4rem; font-weight:bold; margin-top:10px;">MI AI Assistant</div>
    <span class="call-lang-badge" style="margin-top:5px; padding:4px 12px; border-radius:20px; background:rgba(255,255,255,0.1); font-size:0.85rem;">
      ${callLangLabel === 'Urdu' || callLangLabel === 'Arabic' ? '<span class="call-rtl">' + callLangLabel + '</span>' : callLangLabel} 🎙️
    </span>

    <div class="call-wave" id="call-wave" style="margin:25px 0;"><span></span><span></span><span></span><span></span><span></span></div>

    <div class="call-status" id="call-status" style="font-size:1.1rem; color:var(--p); font-weight:bold;">📞 Ringing...</div>

    <div class="call-transcript" id="call-transcript" style="min-height:30px; margin-top:10px; font-size:1rem; color:#fff; ${callLang === 'ur-PK' || callLang === 'ar-SA' ? 'direction:rtl;font-family:var(--fa)' : ''}"></div>

    <div id="call-ai-text" style="font-size:0.9rem;color:var(--ts);max-width:340px;text-align:center;padding:10px 18px;line-height:1.6;min-height:50px; ${callLang === 'ur-PK' || callLang === 'ar-SA' ? 'direction:rtl;font-family:var(--fa)' : ''}"></div>

    <div class="call-btns" style="margin-top:auto; padding-bottom:40px; display:flex; gap:20px;">
      <button class="call-btn mute" id="call-mute-btn" onclick="toggleCallMute()" title="Mute/Unmute" style="width:60px;height:60px;font-size:1.5rem;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,0.1);color:#fff;">🎤</button>
      <button class="call-btn end" onclick="endCall()" title="End Call" style="width:60px;height:60px;font-size:1.5rem;border-radius:50%;border:none;cursor:pointer;background:#e74c3c;color:#fff;box-shadow: 0 0 15px rgba(231,76,60,0.5);">📵</button>
    </div>
  `;
  setWaveMode('ringing');

  // Mic Permission Request via getUserMedia (works in WebView with onPermissionRequest grant)
  requestMicStream().then((stream) => {
    if (!callActive) { stopMicStream(stream); return; }
    callMediaStream = stream;
    setCallStatus('☎️ Establishing secure connection...');

    setTimeout(() => {
      if (!callActive) return;
      setCallStatus('✅ Connected!');
      greetCall(); // AI ki pehli aawaz
    }, 1200);
  }).catch(() => {
    if (!callActive) return;
    setCallStatus('⚠️ Microphone permission denied');
    if (typeof toast === 'function') toast('Please allow microphone access in app/browser settings', 'er');
  });
}

// Requests a persistent mic stream that stays open for the whole call
// (unlike the old per-check stream that immediately stopped its tracks).
function requestMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
}

function stopMicStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
}

// ════════════════════════════════════════════════════════════════════════════════
// 2. AI INITIAL GREETING (Pehla Jawab)
// ════════════════════════════════════════════════════════════════════════════════
async function greetCall() {
  setCallStatus('🤖 MI AI is speaking...');
  setWaveMode('ai');

  const greetings = {
    'en-US': 'Assalamu Alaikum! I am MI AI, your intelligent assistant by Muaaz Iqbal from Muslim Islam Org. How can I assist you today?',
    'ur-PK': 'السلام علیکم! میں MI AI ہوں، معاذ اقبال کا ذہین اسسٹنٹ۔ بتائیے، آج میں آپ کی کیا مدد کر سکتا ہوں؟',
    'ar-SA': 'السلام عليكم! أنا MI AI، مساعدك الذكي من معاذ إقبال. كيف يمكنني مساعدتك اليوم؟',
    'hi-IN': 'Assalamu Alaikum! Main MI AI hoon, Muaaz Iqbal ka intelligent assistant. Aaj main aapki kaise madad karoon?'
  };

  const greeting = greetings[callLang] || greetings['en-US'];

  callHistory.push({ role: 'assistant', content: greeting });
  setCallAIText(greeting);

  await speakCall(greeting); // Pehle AI apni baat puri karega
  if (callActive && !callMuted) beginListenCycle(); // Phir mic on hoga
}

// ════════════════════════════════════════════════════════════════════════════════
// 3. COMFORTABLE LISTENING ENGINE — MediaRecorder + Voice-Activity Detection
//    (Replaces SpeechRecognition. Same 1.9s "golden pause" comfort feel.)
// ════════════════════════════════════════════════════════════════════════════════
function beginListenCycle() {
  if (!callActive || callMuted || callSpeaking) return;
  callListenGen++; // Naya session start
  startCallListening(callListenGen);
}

function startCallListening(gen) {
  if (!callActive || callMuted || callSpeaking) return;
  if (gen !== callListenGen) return; // Purana session ignore karo
  if (!callMediaStream) return;

  stopRecorderInternal(); // Agar koi purana recorder chal raha ho to band karo

  callAudioChunks = [];

  let mimeType = 'audio/webm';
  if (!MediaRecorder.isTypeSupported('audio/webm')) {
    mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  }

  const recorder = mimeType
    ? new MediaRecorder(callMediaStream, { mimeType })
    : new MediaRecorder(callMediaStream);

  callRecorder = recorder;

  recorder.ondataavailable = (e) => {
    if (gen !== callListenGen) return;
    if (e.data && e.data.size > 0) callAudioChunks.push(e.data);
  };

  recorder.onstart = () => {
    if (gen !== callListenGen) return;
    setCallStatus('🎙️ Listening... speak now');
    setWaveMode('listening');
    startVoiceActivityDetection(gen);
  };

  recorder.onstop = () => {
    stopVoiceActivityDetection();
    if (gen !== callListenGen || !callActive) return;

    const blob = new Blob(callAudioChunks, { type: mimeType || 'audio/webm' });
    callAudioChunks = [];

    if (blob.size < 800) {
      // Too short / silence only — restart listening quietly
      if (!callMuted && !callSpeaking) {
        setTimeout(() => { if (gen === callListenGen) beginListenCycle(); }, 400);
      }
      return;
    }

    transcribeAudio(blob, gen);
  };

  recorder.onerror = () => {
    stopVoiceActivityDetection();
    if (gen !== callListenGen || !callActive) return;
    setCallStatus('⚠️ Mic error — retrying...');
    if (!callMuted && !callSpeaking) setTimeout(() => { if (gen === callListenGen) beginListenCycle(); }, 1200);
  };

  try {
    recorder.start();
  } catch (e) {
    setCallStatus('Mic error: ' + e.message);
  }
}

// ── Voice Activity Detection: replaces the old "interim result" silence timer.
// We watch live volume levels via Web Audio API. When volume drops below a
// threshold for ~1.9s AFTER speech was detected, we stop the recorder — same
// "golden pause" comfort behaviour as the original SpeechRecognition version.
function startVoiceActivityDetection(gen) {
  try {
    callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = callAudioCtx.createMediaStreamSource(callMediaStream);
    callAnalyser = callAudioCtx.createAnalyser();
    callAnalyser.fftSize = 512;
    source.connect(callAnalyser);

    const data = new Uint8Array(callAnalyser.frequencyBinCount);
    let speechDetected = false;
    let silenceStart = null;
    const SPEECH_THRESHOLD = 14;   // volume level considered "speaking"
    const SILENCE_MS = 1900;       // the original "golden pause"
    const MAX_RECORD_MS = 20000;   // hard safety cap per utterance
    const startedAt = Date.now();

    function tick() {
      if (gen !== callListenGen || !callRecorder || callRecorder.state !== 'recording') {
        return;
      }
      callAnalyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;

      if (avg > SPEECH_THRESHOLD) {
        speechDetected = true;
        silenceStart = null;
        setCallTranscript('🎙️ Listening...');
      } else if (speechDetected) {
        if (silenceStart === null) silenceStart = Date.now();
        if (Date.now() - silenceStart > SILENCE_MS) {
          stopRecorderInternal();
          return;
        }
      }

      if (Date.now() - startedAt > MAX_RECORD_MS) {
        stopRecorderInternal();
        return;
      }

      callVoiceDetectFrame = requestAnimationFrame(tick);
    }

    callVoiceDetectFrame = requestAnimationFrame(tick);
  } catch (e) {
    console.error('Voice activity detection failed, falling back to fixed window:', e);
    // Fallback: just record for a fixed window if Web Audio analysis fails
    setTimeout(() => stopRecorderInternal(), 4000);
  }
}

function stopVoiceActivityDetection() {
  if (callVoiceDetectFrame) {
    cancelAnimationFrame(callVoiceDetectFrame);
    callVoiceDetectFrame = null;
  }
  if (callAudioCtx) {
    try { callAudioCtx.close(); } catch (e) {}
    callAudioCtx = null;
  }
  callAnalyser = null;
}

function stopRecorderInternal() {
  if (callRecorder && callRecorder.state === 'recording') {
    try { callRecorder.stop(); } catch (e) {}
  }
  callRecorder = null;
}

function stopListening() {
  callListenGen++; // Ensure old loops die
  if (callSilenceTimer) { clearTimeout(callSilenceTimer); callSilenceTimer = null; }
  stopVoiceActivityDetection();
  stopRecorderInternal();
}

// ════════════════════════════════════════════════════════════════════════════════
// 3b. GROQ WHISPER TRANSCRIPTION (replaces SpeechRecognition's onresult)
// ════════════════════════════════════════════════════════════════════════════════
async function transcribeAudio(blob, gen) {
  if (gen !== callListenGen || !callActive) return;
  setCallStatus('📝 Transcribing...');

  const whisperLangMap = {
    'en-US': 'en',
    'ur-PK': 'ur',
    'ar-SA': 'ar',
    'hi-IN': 'hi'
  };

  const maxAttempts = Math.max(1, GROQ_WHISPER_KEYS.length);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = getNextGroqKey();
    try {
      const form = new FormData();
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      form.append('file', blob, `call-audio.${ext}`);
      form.append('model', 'whisper-large-v3');
      if (whisperLangMap[callLang]) form.append('language', whisperLangMap[callLang]);

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
        body: form
      });

      if (res.status === 429 || res.status === 401) {
        cooldownGroqKey(key, res.status === 429 ? 30000 : 600000);
        lastError = new Error('Groq key rate-limited or invalid (status ' + res.status + ')');
        continue; // try next key
      }

      if (!res.ok) {
        lastError = new Error('Transcription failed with status ' + res.status);
        continue;
      }

      const json = await res.json();
      const heard = (json.text || '').trim();

      if (gen !== callListenGen || !callActive) return;

      if (heard) {
        processCallInput(heard);
      } else if (!callMuted && !callSpeaking) {
        setTimeout(() => { if (gen === callListenGen) beginListenCycle(); }, 400);
      }
      return; // success — stop trying more keys

    } catch (e) {
      lastError = e;
      continue;
    }
  }

  // All attempts failed
  console.error('Whisper transcription error:', lastError);
  if (gen !== callListenGen || !callActive) return;
  setCallStatus('⚠️ Network/Transcription error — retrying...');
  if (!callMuted && !callSpeaking) setTimeout(() => { if (gen === callListenGen) beginListenCycle(); }, 1200);
}

// ════════════════════════════════════════════════════════════════════════════════
// 4. PROCESS CALL INPUT & ADVANCED AUTO-DISCONNECT (unchanged logic)
// ════════════════════════════════════════════════════════════════════════════════
async function processCallInput(text) {
  if (!callActive) return;
  stopListening(); // Mic completely off taake background noise API ko na jaye

  setCallTranscript('🗣️ ' + text);
  setCallAIText('');

  const cleanInput = text.toLowerCase().trim();

  const endKeywords = [
    'call band', 'band kar do', 'call kat', 'call kato', 'bye', 'allah hafiz',
    'khuda hafiz', 'end call', 'disconnect', 'tata', 'phone kato', 'phun kato',
    'alvida', 'stop call', 'close call', 'goodbye', 'band karo', 'bad kar do', 'rakh do phone'
  ];

  const userWantsToHangUp = endKeywords.some(keyword => cleanInput.includes(keyword));

  if (userWantsToHangUp) {
    setCallStatus('🤖 Disconnecting gracefully...');
    setWaveMode('ai');

    let goodbyeText = 'Allah Hafiz! Apna khayal rakhiyega. Call band ki ja rahi hai.';
    if (callLang === 'en-US') goodbyeText = 'Goodbye! Take care of yourself, disconnecting the call now.';
    if (callLang === 'ar-SA') goodbyeText = 'مع السلامة! في أمان الله، يتم إنهاء المكالمة الآن.';
    if (callLang === 'hi-IN') goodbyeText = 'Alvida! Apna dhyan rakhna. Call disconnect ki ja rahi hai.';

    setCallAIText(goodbyeText);
    await speakCall(goodbyeText);
    endCall();
    return;
  }

  callHistory.push({ role: 'user', content: text });
  setCallStatus('⚡ Thinking securely...');
  setWaveMode('silent');

  try {
    const sys = `You are MI AI — a reliable, smart, and concise voice assistant by Muaaz Iqbal (Muslim Islam Org).
STRICT CALL RULES:
- Reply STRICTLY based on the user's prompt. No assumptions, no storytelling.
- MAXIMUM 1 to 2 short sentences. Absolutely NEVER generate paragraphs.
- Keep it raw text. NO markdown formatting, NO bullets, NO headers, NO bold text.
- Sound conversational, polite, and like a real human on a voice call.
- If they ask a deeply complex question, give a one-sentence summary and add: "I can explain more if you want."`;

    const callModel = 'llama-3.1-8b-instant';

    // Assuming qCall is your existing external chat API handler (unchanged)
    const resp = await qCall(text, callModel, sys, callHistory.slice(-6));

    const clean = (resp || '').replace(/[*_#`\[\]]/g, '').replace(/\n+/g, ' ').trim();

    callHistory.push({ role: 'assistant', content: clean });
    setCallAIText(clean);

    setCallStatus('🤖 Speaking...');
    setWaveMode('ai');

    await speakCall(clean);
    if (callActive && !callMuted) beginListenCycle();

  } catch (e) {
    console.error('Call processing error:', e);
    if (!callActive) return;
    setCallStatus('⚠️ Connection glitch, retrying...');
    if (!callMuted) setTimeout(beginListenCycle, 1000);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 5. REALISTIC EMOTIONAL TTS ENGINE (unchanged — still uses speechSynthesis,
//    which DOES work fine inside WebView, unlike SpeechRecognition)
// ════════════════════════════════════════════════════════════════════════════════
function speakCall(text) {
  return new Promise(res => {
    callSpeaking = true;
    stopListening(); // Security: Mic MUST be off when AI is talking
    window.speechSynthesis.cancel();

    const clean = (text || '').replace(/[#*`_\[\]()\u200B-\u200D]/g, '').replace(/\n+/g, ' ').trim().substring(0, 500);
    if (!clean) { callSpeaking = false; res(); return; }

    const isHappy = /happy|great|amazing|wonderful|love|haha|lol|خوش|شکریہ|اچھا|سعيد|يسعدني|alhamdulillah/i.test(clean);
    const isSad = /sorry|sad|difficult|افسوس|مشکل|أسف|حزين|apologize/i.test(clean);
    const isExcited = /wow|excellent|fantastic|incredible|بہترین|شاندار|رائع/i.test(clean);

    const u = new SpeechSynthesisUtterance(clean);

    u.rate = isExcited ? 1.08 : isSad ? 0.88 : 0.98;
    u.pitch = isHappy || isExcited ? 1.1 : isSad ? 0.9 : 1.02;
    u.volume = 1;
    u.lang = callLang || 'en-US';

    const voices = window.speechSynthesis.getVoices();
    const tl = (callLang || 'en-US').split('-')[0];
    const pref =
      voices.find(v => v.lang === callLang && v.name.includes('Google')) ||
      voices.find(v => v.lang.startsWith(tl) && v.name.includes('Google')) ||
      voices.find(v => v.lang.startsWith(tl)) ||
      voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
      voices.find(v => v.lang.startsWith('en')) || voices[0];

    if (pref) u.voice = pref;

    const safeDuration = Math.min(clean.length * 110 + 1500, 15000);
    const to = setTimeout(() => { window.speechSynthesis.cancel(); callSpeaking = false; res(); }, safeDuration);

    const ka = setInterval(() => {
      if (!callSpeaking) { clearInterval(ka); return; }
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    }, 4000);

    u.onend = () => { clearTimeout(to); clearInterval(ka); callSpeaking = false; res(); };
    u.onerror = () => { clearTimeout(to); clearInterval(ka); callSpeaking = false; res(); };

    window.speechSynthesis.speak(u);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// 6. UI CONTROLS & END CALL LOGIC
// ════════════════════════════════════════════════════════════════════════════════
function endCall() {
  callActive = false;
  stopListening();
  callSpeaking = false;
  window.speechSynthesis.cancel();

  if (callMediaStream) {
    stopMicStream(callMediaStream);
    callMediaStream = null;
  }

  const _endOv = document.getElementById('call-overlay');
  if (_endOv) {
    _endOv.classList.remove('show');
    _endOv.style.display = 'none';
  }

  if (callHistory.length > 2 && typeof addMsg === 'function') {
    const summary = callHistory.filter(m => m.role === 'user').map(m => m.content).join(' | ');
    addMsg('assistant', `📞 **Call Ended**\n\nThe live AI call has been disconnected. Here is a brief summary of what you asked:\n\n*${summary.substring(0, 400)}${summary.length > 400 ? '...' : ''}*`, true);
  }

  if (typeof toast === 'function') toast('Call ended successfully', 'in');
  if (typeof resumeMusicAfterCall === 'function') resumeMusicAfterCall();
}

function toggleCallMute() {
  callMuted = !callMuted;
  const btn = document.getElementById('call-mute-btn');
  if (!btn) return;

  if (callMediaStream) {
    callMediaStream.getAudioTracks().forEach(t => { t.enabled = !callMuted; });
  }

  if (callMuted) {
    btn.textContent = '🔇';
    btn.style.background = '#e74c3c';
    btn.style.boxShadow = '0 0 15px rgba(231,76,60,0.6)';
    stopListening();
    setCallStatus('Microphone is Muted');
    setWaveMode('silent');
  } else {
    btn.textContent = '🎤';
    btn.style.background = 'rgba(255,255,255,0.1)';
    btn.style.boxShadow = 'none';
    setCallStatus('Microphone Active — listening...');
    beginListenCycle();
  }
}

// Helper Functions for DOM Updates (unchanged)
function setCallStatus(txt) {
  const el = document.getElementById('call-status');
  if (el) el.textContent = txt;
}
function setCallTranscript(txt) {
  const el = document.getElementById('call-transcript');
  if (el) el.textContent = txt;
}
function setCallAIText(txt) {
  const el = document.getElementById('call-ai-text');
  if (el) el.textContent = txt ? '🤖 ' + txt.substring(0, 250) + (txt.length > 250 ? '...' : '') : '';
}

function setWaveMode(mode) {
  const wave = document.getElementById('call-wave');
  const avatar = document.getElementById('call-avatar');
  if (!wave || !avatar) return;

  wave.className = 'call-wave' + (mode === 'ai' ? ' ai' : mode === 'silent' ? ' silent' : mode === 'ringing' ? ' ringing' : '');
  avatar.className = 'call-avatar' + (mode === 'ai' ? ' call-ai-speaking' : mode === 'ringing' ? ' call-ringing' : '');

  if (mode === 'ai') {
    avatar.style.transform = 'scale(1.15)';
    avatar.style.textShadow = '0 0 30px var(--p)';
  } else {
    avatar.style.transform = 'scale(1)';
    avatar.style.textShadow = 'none';
  }
}
