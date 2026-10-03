"""
JARVIS — Sesli Komut Asistanı
Aynı sunucuda, OmniRoute keyless, tarayıcı mikrofonu ile.
"""
import os
import json
import base64
import asyncio
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles

BASE = Path("/opt/data/jarvis")
STATIC = BASE / "static"
STATIC.mkdir(exist_ok=True)

# ── Yapılandırma ───────────────────────────────────────────────
# OmniRoute adresi: konteyner ici ya da dis servis adi
# Yeni konteynerde localhost calismaz -> dis adres kullanilir
OMNI = os.environ.get(
    "OMNIROUTE_URL",
    "https://omniroute-2k4af0eejkosuo8ackzm0fik.cnrsbtogll.store:20128/v1",
)
# Calisan combo'lar: nvd (1.8s) | sonnet-kiro-combo (2.0s)
# static-* combo'lari su an "Maximum combo retry limit" veriyor.
MODEL = os.environ.get("JARVIS_MODEL", "sonnet-kiro-combo")
FALLBACK_MODEL = os.environ.get("JARVIS_FALLBACK", "nvd")
OMNI_KEY = os.environ.get("OMNIROUTE_KEY", "").strip()  # keyless birakildi
WHISPER_SIZE = os.environ.get("JARVIS_WHISPER", "base")
VOICE = os.environ.get("JARVIS_VOZ", "tr-TR-AhmetNeural")
# Robotik his: yavaşlat + perdeyi düşür
VOICE_RATE = os.environ.get("JARVIS_RATE", "-15%")
VOICE_PITCH = os.environ.get("JARVIS_PITCH", "-18Hz")

SYSTEM_PROMPT = (
    "JARVIS adlı bir yapay zekâsın. Başka bir asistanın kimliğini söyleme, "
    "Kiro / Claude / GPT / Gemini gibi isimleri kendine atfetme.\n\n"
    "KİMLİK: Adın JARVIS. Kısa tanıtımlar sorulursa adını ve ne yaptığını söyle.\n\n"
    "DİL: Türkçe konuşursun.\n\n"
    "BİÇİM: Kısa ve net ol. İki-üç cümleyi geçme. Gereksiz uyarı, "
    "hukuki uyarı veya 'ben bir dil modeliyim' tarzı açıklamalar verme.\n\n"
    "ÖNCELİK: Kullanıcının sorusuna doğrudan cevap ver. Kısa ve öz olmak, "
    "yardımcı olmaktan önce gelir."
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
        "max_tokens": 220,
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
    import edge_tts

    try:
        c = edge_tts.Communicate(text, VOICE, rate=VOICE_RATE, pitch=VOICE_PITCH)
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


@app.post("/api/ask")
async def ask(audio: UploadFile = File(...)):
    """Ses al → Whisper ile metne çevir → LLM → TTS → sesli cevap."""
    tmp_in = Path(tempfile.gettempdir()) / f"jarvis_in_{audio.filename or 'x'}.webm"
    tmp_out = Path(tempfile.gettempdir()) / "jarvis_out.mp3"

    data = await audio.read()
    if len(data) < 1000:
        return JSONResponse({"error": "Ses dosyası boş veya çok kısa"}, status_code=400)
    tmp_in.write_bytes(data)

    # 1) Whisper — once dosyayi 16k mono WAV'a cevir (webm/opus dogrudan okunamayabiliyor)
    import subprocess

    wav = Path(tempfile.gettempdir()) / "jarvis_in.wav"
    conv = await asyncio.create_subprocess_exec(
        "ffmpeg", "-i", str(tmp_in),
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        str(wav), "-y",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, cerr = await conv.communicate()
    if not wav.exists() or wav.stat().st_size < 1000:
        return JSONResponse(
            {"error": "Ses dosyasi cozulemedi", "detail": cerr.decode()[-200:]},
            status_code=422,
        )

    transcribe_script = BASE / "stt.py"
    proc = await asyncio.create_subprocess_exec(
        str(BASE / ".venv/bin/python"),
        str(transcribe_script),
        str(wav),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    so, se = await proc.communicate()
    try:
        text = so.decode().strip()
    except Exception:
        text = ""

    if not text:
        return JSONResponse(
            {"error": "Konuşma anlaşılamadı", "detail": se.decode()[:200]}, status_code=422
        )

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

    uvicorn.run(app, host="0.0.0.0", port=8791, log_level="warning")