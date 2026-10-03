// ══════════════════════════════════════════════════════════════
// KARŞILIKLI KONUŞMA: Uyandırma + odaklı dinleme
//
// Akış:
//   1. Sürekli dinle (her zaman açık mikrofon)
//   2. "Jarvis" duyuldu -> ANINDA komut moduna geç (kelime kaydı at)
//   3. Komut modunda konuşma bitene kadar dinle (VAD ile sessizlik algıla)
//   4. Sessizlik 1.2 sn sürdü -> Whisper + LLM + cevap
//   5. Cevabı sesli ver, sonra tekrar uyanma moduna dön
//
// Kritik: uyandırma kelimesi kaydın KENDİSİNDEN ayrılır, yoksa
// "Jarvis saat kaç" dediğinde komut kısmen kaybolur.
// ══════════════════════════════════════════════════════════════

const WAKE_WORDS = [
  'jarvis', 'jarvez', 'yarvis', 'jarvıs', 'charvis', 'carvis',
  'jervis', 'jarvis', 'jaruis', 'jarviss', 'jarves'
];
// Whisper bazen "jarvis"i böyle yazıyor; kelime bazlı eşleşme + tolerans
const WAKE_RE = new RegExp(
  '\\b(' + WAKE_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i'
);

let wake = {
  on: false,
  stream: null,
  rec: null,
  analyser: null,
  ctx: null,          // AudioContext (sessizlik ölçümü için)
  chunks: [],
  phase: 'idle',      // idle | wakewait | command | replying
  sliceTimer: null,
  silenceTimer: null,
  maxTimer: null,
  cmdText: '',        // uyanma anından beri biriken metin
  speaking: false     // JARVIS konuşuyorken mikrofonu kapat (yankı)
};

const SILENCE_MS = 1200;      // bu kadar sessizlik = konuşma bitti
const WAKE_SLICE_MS = 1500;    // uyanma kelimesi arama dilimi
const CMD_MAX_MS = 15000;      // komut için maksimum süre
const VOICE_FLOOR = 0.012;     // bu RMS altı = sessizlik

// ── SES SEVİYESİ ÖLÇÜMÜ ───────────────────────────────────────
function rmsLevel(){
  if (!wake.analyser) return 0;
  const buf = new Float32Array(wake.analyser.fftSize);
  wake.analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function clearTimers(){
  clearTimeout(wake.sliceTimer);
  clearTimeout(wake.silenceTimer);
  clearTimeout(wake.maxTimer);
  wake.sliceTimer = wake.silenceTimer = wake.maxTimer = null;
}

// ── KOMUT MODUNDAN UYANMA MODUNA DÖNÜŞ ─────────────────────────
function sleepPhase(){
  if (!wake.on) return;
  clearTimers();
  wake.phase = 'wakewait';
  wake.chunks = [];
  setState('listening');
  status.textContent = 'BEKLEMEDE — "JARVIS" DE';
  startSlice();
}

// ── UYANMA KELİMESİ ARAMA DÖNGÜSÜ ─────────────────────────────
function startSlice(){
  if (!wake.on || wake.phase !== 'wakewait') return;
  try { wake.rec.start(); } catch(e){}

  wake.sliceTimer = setTimeout(async () => {
    if (!wake.on || wake.phase !== 'wakewait') return;
    try { wake.rec.stop(); } catch(e){}

    const blob = new Blob(wake.chunks, { type: wake.rec.mimeType || 'audio/webm' });
    wake.chunks = [];
    if (blob.size < 900) { sleepPhase(); return; }

    const fd = new FormData();
    fd.append('audio', blob, 'wake' + extOf(blob.type));

    try {
      const r = await fetch('/api/wake', { method:'POST', body: fd });
      const j = await r.json();
      if (j.wake) {
        wake.cmdText = j.text || '';   // uyanma kelimesinin tanındığı metin
        toCommandMode();
      } else {
        sleepPhase();
      }
    } catch(e) {
      sleepPhase();
    }
  }, WAKE_SLICE_MS);
}

function extOf(mime){
  if (!mime) return '.webm';
  if (mime.includes('mp4')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  return '.webm';
}

// ── KOMUT MODU: KONUŞMA BİTENE KADAR DİNLE ─────────────────────
function toCommandMode(){
  wake.phase = 'command';
  stopAudio();                 // JARVIS sesini kapat
  setState('listening');
  status.textContent = 'DİNLEMEDE — KONUŞ';
  add('◉ Jarvis duydum. Konuş.','sys');

  // Mikrofonu konuşma anında aç (yarış durumu olmasın)
  setTimeout(() => {
    if (!wake.on || wake.phase !== 'command') return;
    try {
      wake.rec.start(200);
      wake.cmdText = '';
    } catch(e) { sleepPhase(); return; }

    // Sessizlik izleyici: her 200 ms RMS ölç
    const watch = setInterval(() => {
      if (!wake.on || wake.phase !== 'command'){ clearInterval(watch); return; }
      const lvl = rmsLevel();
      if (lvl < VOICE_FLOOR) {
        // sessizlik başladı
        if (!wake.silenceTimer) {
          wake.silenceTimer = setTimeout(() => {
            wake.silenceTimer = null;
            if (wake.phase === 'command') submitCommand();
          }, SILENCE_MS);
        }
      } else if (wake.silenceTimer) {
        // konuşma devam ediyor, sessizlik sayacını iptal et
        clearTimeout(wake.silenceTimer);
        wake.silenceTimer = null;
      }
    }, 200);

    // Maksimum süre
    wake.maxTimer = setTimeout(() => {
      clearInterval(watch);
      if (wake.phase === 'command') submitCommand();
    }, CMD_MAX_MS);
  }, 300);
}

async function submitCommand(){
  if (!wake.on || wake.phase !== 'command') return;
  wake.phase = 'replying';
  clearTimers();

  try { wake.rec.stop(); } catch(e){}
  const blob = new Blob(wake.chunks, { type: wake.rec.mimeType || 'audio/webm' });
  wake.chunks = [];
  await sleep(250);            // son chunk'ın gelmesi için

  if (blob.size < 1500){
    add('Ses gelmedi.','sys');
    sleepPhase();
    return;
  }

  const secs = (blob.size / 16000).toFixed(1);
  add('⏺ ' + blob.size + ' bayt · ' + secs + ' sn','sys');

  setState('thinking');
  status.textContent = 'ANALİZ';

  const fd = new FormData();
  fd.append('audio', blob, 'cmd' + extOf(blob.type));
  try {
    const r = await fetch('/api/ask', { method:'POST', body: fd });
    const j = await r.json();
    if (j.error){
      add('Hata: ' + j.error,'sys');
      sleepPhase();
      return;
    }
    add(j.text,'you');
    const b = document.createElement('div');
    b.className = 'msg jar';
    b.textContent = j.reply;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;

    // Cevabı sesli ver, bitince uyanma moduna dön
    wake.speaking = true;
    speakReply(j.reply, j.audio);
    const back = setInterval(() => {
      if (!wake.on || wake.phase !== 'replying'){ clearInterval(back); return; }
      if (!isPlaying()){
        clearInterval(back);
        wake.speaking = false;
        sleepPhase();
      }
    }, 300);
    // güvenlik: 25 sn sonra zorla dön
    setTimeout(() => {
      clearInterval(back);
      wake.speaking = false;
      if (wake.phase === 'replying') sleepPhase();
    }, 25000);
  } catch(e) {
    add('Bağlantı hatası.','sys');
    sleepPhase();
  }
}

function isPlaying(){
  if (currentAudio && !currentAudio.paused && !currentAudio.ended) return true;
  if ('speechSynthesis' in window && speechSynthesis.speaking) return true;
  return false;
}

// ── AÇ / KAPA ─────────────────────────────────────────────────
async function startWakeMode(){
  if (wake.on) return;
  if (recStream){ add('Önce bas-konuş kaydını bitir.','sys'); return; }

  try {
    wake.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
  } catch(e){
    add('Mikrofon hatası: ' + e.message,'sys');
    return;
  }

  // AudioContext: RMS ölçümü için (ayrı bir kayıt yapmaz, stream'i paylaşır)
  try {
    wake.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = wake.ctx.createMediaStreamSource(wake.stream);
    wake.analyser = wake.ctx.createAnalyser();
    wake.analyser.fftSize = 2048;
    src.connect(wake.analyser);
  } catch(e){}

  const Recorder = window.MediaRecorder || window.webkitMediaRecorder;
  const mime = ['audio/webm;codecs=opus','audio/webm','audio/mp4']
    .find(t => Recorder.isTypeSupported && Recorder.isTypeSupported(t));
  wake.rec = mime ? new Recorder(wake.stream, { mimeType: mime }) : new Recorder(wake.stream);

  wake.rec.ondataavailable = e => { if (e.data && e.data.size > 0) wake.chunks.push(e.data); };
  wake.on = true;
  $('rec').classList.add('on');
  $('wake').style.background = 'rgba(255,176,0,.2)';
  add('🎤 Uyandırma modu — "Jarvis" de. Sonra konuş, susunca cevap veririm.','sys');
  sleepPhase();
}

function stopWakeMode(){
  wake.on = false;
  wake.phase = 'idle';
  clearTimers();
  stopAudio();
  if (wake.rec){ try { if (wake.rec.state !== 'inactive') wake.rec.stop(); } catch(e){} }
  if (wake.stream){ wake.stream.getTracks().forEach(t => t.stop()); wake.stream = null; }
  if (wake.ctx){ try { wake.ctx.close(); } catch(e){} wake.ctx = null; wake.analyser = null; }
  $('rec').classList.remove('on');
  $('wake').style.background = '';
  setState(null);
  add('⏸ Uyandırma modu kapatıldı','sys');
}