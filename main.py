"""Railpack / Coolify varsayılan giriş noktası.

Coolify Dockerfile kullanmadığında Railpack devreye girip `main.py` arıyor.
Bu dosya server.py'i içe aktarır; hangi yol seçilirse çalışır.
"""
from server import app  # noqa: F401

if __name__ == "__main__":
    import os

    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8791")),
        log_level="warning",
    )