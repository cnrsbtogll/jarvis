"""
JARVIS — Sesli Komut Asistanı
Aynı sunucuda, OmniRoute keyless, tarayıcı mikrofonu ile.
"""
import os
import io
import json
import base64
import asyncio
import functools
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles

# Klasör yolu: Docker imajinda /app, yerel calistirmada /opt/data/jarvis
BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
STATIC.mkdir(exist_ok=True)
AUDIO_TMP = Path(tempfile.gettempdir()) / "jarvis"

# ── Yapılandırma ───────────────────────────────────────────────
# OmniRoute adresi.
# DIKKAT: :20128 eklenmemeli — o port Coolify proxy'de disariya acik degil
# (connection refused). Ana public link (443/https) keyless calisiyor:
#   /v1/models            -> 401 (beklenen, keyless)
#   /v1/chat/completions  -> 200 keyless
OMNI = os.environ.get(
    "OMNIROUTE_URL",
    "https://omniroute-2k4af0eejkosuo8ackzm0fik.cnrsbtogll.store/v1",
)
# Calisan combo'lar: nvd (1.8s) | sonnet-kiro-combo (2.0s)
# static-* combo'lari su an "Maximum combo retry limit" veriyor.
MODEL = os.environ.get("JARVIS_MODEL", "sonnet-kiro-combo")
FALLBACK_MODEL = os.environ.get("JARVIS_FALLBACK", "nvd")
OMNI_KEY = os.environ.get("OMNIROUTE_KEY", "").strip()  # keyless birakildi
WHISPER_SIZE = os.environ.get("JARVIS_WHISPER", "base")
VOICE = os.environ.get("JARVIS_VOZ", "tr-TR-AhmetNeural")
# Robotik his: yavaşlat + perdeyi düşür
VOICE_RATE = os.environ.get("JARVIS_RATE", "+12%")
VOICE_PITCH = os.environ.get("JARVIS_PITCH", "-12Hz")

SYSTEM_PROMPT = (
    "JARVIS adlı bir yapay zekâsın. Başka bir asistanın kimliğini söyleme, "
    "Kiro / Claude / GPT / Gemini gibi isimleri kendine atfetme.\n\n"
    "KİMLİK: Adın JARVIS.\n\n"
    "DİL: Türkçe.\n\n"
    "UZUNLUK — BU EN ÖNEMLİ KURAL: Cevabın EN FAZLA 2 cümle olsun. "
    "Tek cümle yeterliyse tek cümle yaz. Gereksiz açıklama, tekrarlama, "
    "giriş cümlesi ve selamlaşma YAZMA. Soruyu cevapla ve dur.\n\n"
    "ÖRNEK:\n"
    "Soru: Saat kaç?\n"
    "Kötü: 'Merhaba! Sisteminiz çalışıyor, sağ olun. Şu an saat 14:30. "
    "Başka bir sorunuz var mı?'\n"
    "İyi: 'Saat 14:30.'\n\n"
    "YASAK: 'size nasıl yardımcı olabilirim', 'başka sorunuz var mı', "
    "'umarım yardımcı olabilmiş olurum' gibi kalıpları hiç kullanma.\n\n"
    "Uyarı/hukuki uyarı/lisans metni uydurma."
)

_model = None


def get_whisper():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8")
    return _model


async def llm(text: str, model: str) -> str:
    import urllib.request

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "max_tokens": 110,
        "temperature": 0.7,
    }
    req = urllib.request.Request(
        f"{OMNI}/chat/completions",
        data=json.dumps(payload).encode(),
        headers=(
            {"Content-Type": "application/json", "Authorization": f"Bearer {OMNI_KEY}"}
            if OMNI_KEY
            else {"Content-Type": "application/json"}
        ),
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read())
            return d["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"Hata: {e}"


async def tts(text: str, out: Path) -> bool:
    """edge-tts ile robotik Turkce ses.

    edge-tts metindeki satir sonlarini ve noktalama bosluklarini uzun
    sessizlige cevirir ("cümle arasi cok bekliyor" şikayeti bu yuzden).
    Metni normalize edip tek paragraf haline getiriyoruz.
    """
    import edge_tts
    import re

    # Satir sonlarini kaldir, fazla bosluklari daralt
    clean = re.sub(r"\s*\n\s*", " ", text)
    clean = re.sub(r"\s{2,}", " ", clean).strip()
    # Noktalama sonrasi fazla bosluk (edge-tts bunu uzatir)
    clean = re.sub(r"([.!?:;])\s+", r"\1 ", clean)
    # Uzun tirnak iceren yapilari kirp (WhatsApp/paket metni varsa)
    if len(clean) > 400:
        clean = clean[:400].rsplit(" ", 1)[0] + "."

    try:
        c = edge_tts.Communicate(clean, VOICE, rate=VOICE_RATE, pitch=VOICE_PITCH)
        await c.save(str(out))
        return out.exists() and out.stat().st_size > 1000
    except Exception:
        return False


app = FastAPI(title="JARVIS")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health():
    ok = False
    try:
        r = await llm("test", MODEL)
        ok = not r.startswith("Hata:")
    except Exception:
        ok = False
    return {
        "ok": True,
        "llm_ok": ok,
        "omniroute": OMNI,
        "model": MODEL,
        "voice": VOICE,
        "whisper": WHISPER_SIZE,
    }


@app.post("/api/wake")
async def wake(audio: UploadFile = File(...)):
    """Uyandırma kelimesi kontrolü — komutu çözümlemek için pahalı model kullanma."""
    data = await audio.read()
    if len(data) < 500:
        return {"wake": False, "text": ""}

    segments, _info = await asyncio.get_running_loop().run_in_executor(
        None,
        functools.partial(
            lambda d: get_whisper().transcribe(
                d,
                language="tr",
                beam_size=1,
                vad_filter=True,
                vad_parameters={"threshold": 0.2, "min_silence_duration_ms": 200},
                condition_on_previous_text=False,
                temperature=0.0,
            ),
            io.BytesIO(data),
        ),
    )
    text = " ".join(s.text.strip() for s in segments).strip().lower()

    # Whisper "jarvis"i "yarvis"/"carvis"/"jarvis" gibi yazabiliyor.
    # Bu yuzden_once kabuk harfi eslesmesi, sonra normalize harf eslesmesi.
    hit = any(
        k in text
        for k in ("jarvis", "yarvis", "jarves", "jarwitz", "jarwıs", "charvis", "carvis", "javıs")
    )
    return {"wake": hit, "text": text}


@app.post("/api/ask")
async def ask(audio: UploadFile = File(...)):
    """Ses al → Whisper ile metne çevir → LLM → TTS → sesli cevap."""
    AUDIO_TMP.mkdir(parents=True, exist_ok=True)
    tmp_out = AUDIO_TMP / "out.mp3"

    data = await audio.read()
    if len(data) < 1000:
        return JSONResponse({"error": "Ses dosyası boş veya çok kısa"}, status_code=400)

    # ffmpeg YOK (Railpack imaji apt-get calistirmiyor). PyAV (av paketi)
    # webm/opus, mp4/aac, ogg ve wav dosyalarini kendisi okuyup 16k mono float32'ye
    # cevirir. Bu yuzden ayrica ses donusturme adimi yok.
    segments, _info = await asyncio.get_running_loop().run_in_executor(
        None,
        functools.partial(
            lambda d: get_whisper().transcribe(
                d,
                language="tr",
                beam_size=5,
                vad_filter=True,
                # Kisa Turkce cumleler VAD tarafindan kirpilmasin diye
                # esik dusuruldu ve sessizlik toleransi artirildi
                vad_parameters={
                    "min_silence_duration_ms": 200,
                    "speech_pad_ms": 400,
                    "threshold": 0.2,
                },
                condition_on_previous_text=False,
                temperature=0.0,
            ),
            io.BytesIO(data),
        ),
    )
    text = " ".join(s.text.strip() for s in segments).strip()

    if not text:
        return JSONResponse({"error": "Konuşma anlaşılamadı"}, status_code=422)

    # 2) LLM — keyless, önce nvd, düşerse sonnet-kiro-combo
    reply = await llm(text, MODEL)
    if reply.startswith("Hata:"):
        reply = await llm(text, FALLBACK_MODEL)

    # 3) TTS
    audio_ok = await tts(reply, tmp_out)
    b64 = ""
    if audio_ok:
        b64 = base64.b64encode(tmp_out.read_bytes()).decode()

    return {
        "text": text,
        "reply": reply,
        "audio": b64,
        "audio_mime": "audio/mpeg" if audio_ok else "",
    }


@app.post("/api/text")
async def text_ask(q: str = Form(...)):
    """Sadece yazılı — test için."""
    reply = await llm(q, MODEL)
    tmp = Path(tempfile.gettempdir()) / "jarvis_out.mp3"
    ok = await tts(reply, tmp)
    b64 = base64.b64encode(tmp.read_bytes()).decode() if ok else ""
    return {"text": q, "reply": reply, "audio": b64}


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


if __name__ == "__main__":
    import uvicorn

    # Coolify/Railpack PORT env verir (varsayilan 3000).
    # Docker imajinda bizimkisi 8791.
    port = int(os.environ.get("PORT", "8791"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")