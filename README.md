# JARVIS — Sesli Komut Asistanı

Tarayıcı mikrofonuyla konuşur, sunucuda Whisper ile dinler, OmniRoute (keyless) ile cevap üretir, edge-tts ile robotik Türkçe sesle geri konuşur.

## Mimarî

```
Tarayıcı mikrofonu
   ↓ webm
FastAPI  /api/ask
   ↓ ffmpeg → 16k mono WAV
Whisper (faster-whisper, CPU, base) → metin
   ↓
OmniRoute /v1/chat/completions (keyless) → cevap
   ↓
edge-tts (tr-TR-AhmetNeural) → MP3
   ↓
Tarayıcıda çalar
```

## Çevre değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `JARVIS_MODEL` | `sonnet-kiro-combo` | Ana model. `nvd` sistem prompt'unu ezdiği için varsayılan bu değil. |
| `JARVIS_FALLBACK` | `nvd` | Ana model hata verirse devreye girer. |
| `OMNIROUTE_URL` | OmniRoute dis adresi | Konteyner içi `http://localhost:20128/v1` da olabilir. |
| `OMNIROUTE_KEY` | boş | Boş bırakılırsa keyless çağrı yapılır. |
| `JARVIS_WHISPER` | `base` | `tiny` / `base` / `small`. Hız için `base` yeterli. |
| `JARVIS_VOZ` | `tr-TR-AhmetNeural` | Türkçe sesler: `AhmetNeural` (erkek), `EmelNeural` (kadın). |
| `JARVIS_RATE` | `-15%` | Hız. Daha yavaş robotik için `-25%`. |
| `JARVIS_PITCH` | `-18Hz` | Perde. Daha sert robotik için `-30Hz`. |

## Model notları

`static-*` combo'ları 2026-10-03 itibarıyla `503 Maximum combo retry limit` döndürüyor. Çalışanlar:

- `sonnet-kiro-combo` — 2.0s, sistem prompt'una uyar ✅
- `nvd` — 1.8s, hızlı ama kimliği eziyor ⚠️

## API

| Endpoint | Açıklama |
|---|---|
| `GET /api/health` | `llm_ok` dahil sağlık durumu |
| `POST /api/ask` | `multipart/form-data`, alan: `audio` (webm/wav) |
| `POST /api/text` | `multipart/form-data`, alan: `q` — yazılı test |

`/api/ask` yanıtı:
```json
{
  "text": "duyulan metin",
  "reply": "jarvis cevabı",
  "audio": "base64 MP3",
  "audio_mime": "audio/mpeg"
}
```

## Yerel çalıştırma

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py
```

`http://localhost:8791` — Whisper `base` modeli ilk çalıştırmada ~140 MB indirir.