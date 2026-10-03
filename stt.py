"""Whisper ile ses -> metin. Ayrı script: model bellekte kalıcı olsun diye."""
import sys
from faster_whisper import WhisperModel

SIZE = "base"

def main():
    if len(sys.argv) < 2:
        print("")
        return
    path = sys.argv[1]
    model = WhisperModel(SIZE, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        path,
        language="tr",
        beam_size=1,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        condition_on_previous_text=False,
    )
    out = []
    for s in segments:
        out.append(s.text.strip())
    print(" ".join(out).strip())

if __name__ == "__main__":
    main()