FROM python:3.11-slim

# ffmpeg: Whisper ses dosyasini okur (PyAV -> libav)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py stt.py main.py ./
COPY static/ ./static/

ENV JARVIS_MODEL=sonnet-kiro-combo \
    JARVIS_FALLBACK=nvd \
    OMNIROUTE_URL=https://omniroute-2k4af0eejkosuo8ackzm0fik.cnrsbtogll.store:20128/v1 \
    JARVIS_WHISPER=base \
    JARVIS_VOZ=tr-TR-AhmetNeural \
    JARVIS_RATE=-15% \
    JARVIS_PITCH=-18Hz \
    PORT=8791 \
    PYTHONUNBUFFERED=1

EXPOSE 8791

# LLM cagrisi yapmaz — sadece surec ayakta mi diye bakar
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request,os;urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','8791')+'/api/health').read()"

CMD ["python", "server.py"]