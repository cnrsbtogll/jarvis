// ══════════════════════════════════════════════════════════════
// JARVIS — Karşılıklı konuşma
//
// MİMARİ: Ses algılama (VAD) tamamen tarayıcıda. Sunucuya her
// 1.5 sn ses göndermek yerine, kullanıcı konuşup SUSTUĞUNDA
// tek seferde gönderilir. Önceki tasarımda sunucu Whisper'ı
// takip edemiyor, döngü tıkandığı için uyanma kelimesi hiç
// işlenmiyordu.
//
// Akış:
//   sayfa açılınca otomatik dinleme başlar (buton gerekmez)
//   konuşma algılanır -> yerel tampon birikir
//   1.1 sn sessizlik -> konuşma bitti
//   tek istekte sunucuya gönderilir (WAV)
//   sunucu metni çıkarır, "jarvis" kontrolü yapar
//     ├─ "Jarvis" + komut varsa  -> cevap ver
//     ├─ sadece "Jarvis"        -> dinliyorum modu
//     └─ kelime yoksa          -> yok say
//
// Konuşma sırasında araya girme (barge-in) desteklenir.
// ══════════════════════════════════════════════════════════════

const V = {
  ctx: null, stream: null, src: null, node: null,
  sampleRate: 48000,
  chunks: [],        // {start, data} — ring buffer
  written: 0,        // toplam yazılan örnek sayısı
  maxSamples: 48000 * 40,
  speaking: false,   // kullanıcı konuşuyor mu
  utterStart: 0,     // utterance başlangıç örnek indeksi
  lastVoiceAt: 0,
  enabled: false,
  busy: false,
  jarvisSpeaking: false
};

// Ayarlar
const VAD = {
  threshold: 0.013,     // RMS eşiği — bunun üstü = ses
  hangoverMs: 1100,     // bu kadar sessizlik = konuşma bitti
  preRollMs: 350,       // konuşma başından önceki tampon
  tailMs: 250,          // konuşma sonrası tampon
  minUtterMs: 320,      // bu kadar kısaysa gürültü say
  maxUtterMs: 14000
};

// ── RING BUFFER ────────────────────────────────────────────────
function pushSamples(data){
  V.chunks.push({ start: V.written, data });
  V.written += data.length;
  // eski parçaları at
  const limit = V.written - V.maxSamples;
  while (V.chunks.length && V.chunks[0].start + V.chunks[0].data.length < limit){
    V.chunks.shift();
  }
}

// [a,b) aralığını Float32Array olarak oku
function readRange(a, b){
  a = Math.max(0, a); b = Math.min(V.written, b);
  const out = new Float32Array(Math.max(0, b - a));
  let p = 0;
  for (const c of V.chunks){
    const cs = c.start, ce = c.start + c.data.length;
    if (ce <= a || cs >= b) continue;
    const from = Math.max(a, cs) - cs;
    const to   = Math.min(b, ce) - cs;
    out.set(c.data.subarray(from, to), p);
    p += to - from;
  }
  return out;
}

// ── WAV ENCODER (tarayıcı->sunucu, 16k mono 16-bit) ────────────
function downsample(s, from, to){
  if (from === to) return s;
  const ratio = from / to;
  const n = Math.max(1, Math.floor(s.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++){
    const pos = i * ratio;
    const i0 = pos | 0;
    const i1 = Math.min(i0 + 1, s.length - 1);
    const f = pos - i0;
    out[i] = s[i0] * (1 - f) + s[i1] * f;
  }
  return out;
}

function encodeWAV(samples, rate){
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2){
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function rmsOf(data){
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

// ── KONUŞMA TAMAMLANDI: SUNUCUYA GÖNDER ───────────────────────
async function finalizeUtterance(endSample){
  const startSample = V.utterStart;
  V.speaking = false;
  const durMs = (endSample - startSample) / V.sampleRate * 1000;

  if (durMs < VAD.minUtterMs){ idleState(); return; }

  const pcm = readRange(startSample, endSample);
  const pcm16 = downsample(pcm, V.sampleRate, 16000);
  const wav = encodeWAV(pcm16, 16000);

  if (V.busy){ idleState(); return; }
  V.busy = true;
  setState('thinking');
  status.textContent = 'ANALİZ';

  try {
    const fd = new FormData();
    fd.append('audio', wav, 'utt.wav');
    const r = await fetch('/api/speak', { method:'POST', body: fd });
    const j = await r.json();

    if (j.error){
      add('Hata: ' + j.error, 'sys');
    } else if (j.wake){
      if (j.text) add(j.text, 'you');
      if (j.reply){
        const b = document.createElement('div');
        b.className = 'msg jar';
        b.textContent = j.reply;
        log.appendChild(b); log.scrollTop = log.scrollHeight;
        speakAndResume(j.reply, j.audio);
        V.busy = false;
        return;
      } else {
        // sadece "Jarvis" dendi -> dinliyorum
        setState('listening');
        status.textContent = 'DİNLEMEDE — KONUŞ';
        add('◉ Jarvis duydum. Konuş.','sys');
        V.busy = false;
        idleState(1200);
        return;
      }
    }
    // uyanma kelimesi yok -> yok say
  } catch(e){
    add('Bağlantı hatası','sys');
  }
  V.busy = false;
  idleState();
}

// Cevabı sesli ver, bitince dinlemeye devam
function speakAndResume(txt, b64){
  V.jarvisSpeaking = true;
  stopAudio();
  if (b64) playB64(b64); else speak(txt);

  const watch = setInterval(() => {
    if (!isPlaying()){
      clearInterval(watch);
      V.jarvisSpeaking = false;
      idleState();
    }
  }, 250);
  setTimeout(() => {
    clearInterval(watch);
    V.jarvisSpeaking = false;
    idleState();
  }, 20000);
}

function idleState(delay = 250){
  if (!V.enabled) return;
  clearTimeout(idleState._t);
  idleState._t = setTimeout(() => {
    if (!V.enabled || V.busy) return;
    setState('listening');
    status.textContent = 'BEKLEMEDE — "JARVIS" DE';
  }, delay);
}

// ── VAD DÖNGÜSÜ ───────────────────────────────────────────────
function onAudio(data){
  if (!V.enabled) return;
  const now = performance.now();
  const level = rmsOf(data);

  // JARVIS konuşurken: araya girme kontrolü (echoCancellation çoğunu eler)
  const barge = V.jarvisSpeaking && level > VAD.threshold * 2.5;

  if (level > VAD.threshold || barge){
    if (!V.speaking){
      V.speaking = true;
      V.utterStart = Math.max(0, V.written - Math.floor(VAD.preRollMs * V.sampleRate / 1000));
      if (barge){ stopAudio(); V.jarvisSpeaking = false; }
      setState('listening');
      status.textContent = 'DİNLEMEDE — KONUŞ';
    }
    V.lastVoiceAt = now;
  } else if (V.speaking && now - V.lastVoiceAt > VAD.hangoverMs){
    const end = V.written - Math.floor(VAD.tailMs * V.sampleRate / 1000);
    finalizeUtterance(end);
  }

  // utterance çok uzadıysa kes
  if (V.speaking && (V.written - V.utterStart) / V.sampleRate * 1000 > VAD.maxUtterMs){
    finalizeUtterance(V.written);
  }

  pushSamples(data);
}

// ── MİKROFON AÇ ───────────────────────────────────────────────
async function startVoice(){
  if (V.enabled) return;
  try {
    V.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
  } catch(e){
    $('wake').style.color = '#ff3b5c';
    add('Mikrofon izni verilmedi: ' + e.message + ' — JARVIS düğmesine bas ve izin ver.','sys');
    return;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  V.ctx = new AC();
  if (V.ctx.state === 'suspended') await V.ctx.resume();
  V.sampleRate = V.ctx.sampleRate;

  V.src = V.ctx.createMediaStreamSource(V.stream);

  // ScriptProcessor: her yerde çalışır, bu iş için yeterli
  const size = 2048;
  V.node = V.ctx.createScriptProcessor(size, 1, 1);
  V.node.onaudioprocess = e => {
    // kanal verisini kopyala (mic her zaman mono)
    onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  V.src.connect(V.node);
  // gain 0: işlenmiş sesi hoparlöre gönderme (yankı)
  const mute = V.ctx.createGain();
  mute.gain.value = 0;
  V.node.connect(mute);
  mute.connect(V.ctx.destination);

  V.enabled = true;
  V.chunks = []; V.written = 0; V.speaking = false;
  $('wake').style.background = 'rgba(0,255,157,.15)';
  $('wake').style.borderColor = '#00ff9d';
  $('wake').style.color = '#00ff9d';
  $('rec').classList.add('on');
  add('◉ Dinliyorum. "Jarvis" de, sonra konuş — sustuğunda cevap veririm.','sys');
  idleState(100);
}

function stopVoice(){
  V.enabled = false;
  if (V.node){ try { V.node.disconnect(); } catch(e){} V.node = null; }
  if (V.src){ try { V.src.disconnect(); } catch(e){} V.src = null; }
  if (V.stream){ V.stream.getTracks().forEach(t => t.stop()); V.stream = null; }
  if (V.ctx){ try { V.ctx.close(); } catch(e){} V.ctx = null; }
  V.chunks = []; V.written = 0; V.speaking = false; V.jarvisSpeaking = false;
  $('wake').style.background = '';
  $('wake').style.borderColor = '';
  $('wake').style.color = '';
  $('rec').classList.remove('on');
  setState(null);
  add('⏸ Dinleme kapatıldı','sys');
}

function isPlaying(){
  if (currentAudio && !currentAudio.paused && !currentAudio.ended) return true;
  if ('speechSynthesis' in window && speechSynthesis.speaking) return true;
  return false;
}