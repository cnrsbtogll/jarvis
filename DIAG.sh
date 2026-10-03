#!/bin/bash
# JARVIS teşhis betiği — Coolify terminalinde çalıştır
C=jgiqon3tikztpre0ugrbhtph

echo "══════ 1. KONTEYNER DURUMU ══════"
docker ps -a --filter "name=$C" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "══════ 2. HANGI PORTU DINLIYOR ══════"
docker exec $C sh -c 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null' | grep -E "3000|8791|LISTEN" | head -10

echo ""
echo "══════ 3. ENV (PORT) ══════"
docker exec $C printenv | grep -E "^(PORT|JARVIS|OMNI)" | sort

echo ""
echo "══════ 4. KONTEYNER ICINDE SAGLIK ══════"
docker exec $C sh -c 'wget -qO- http://localhost:${PORT:-3000}/api/health 2>/dev/null || curl -s http://localhost:${PORT:-3000}/api/health 2>/dev/null || echo "IC HATA"'

echo ""
echo "══════ 5. DIS KONTEYNERDEN ══════"
PORT=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $C | grep -oP '(?<=^PORT=).*' || echo 3000)
echo "tespit edilen PORT: $PORT"
docker exec $C python -c "
import urllib.request,os
p=os.environ.get('PORT','3000')
try:
    print('port',p,':',urllib.request.urlopen(f'http://localhost:{p}/api/health',timeout=5).read()[:200])
except Exception as e: print('HATA',e)
"

echo ""
echo "══════ 6. LOGLAR (son 30) ══════"
docker logs --tail 30 $C 2>&1 | tail -30
