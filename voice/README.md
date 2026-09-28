# Local voice service

faster-whisper (speech to text), Kokoro (voice, Piper as fallback) and
openWakeWord ("hey jarvis"), on 127.0.0.1:8790. `npm start` runs it; the
bridge proxies the page's `/stt` and `/tts` to it. If it is down the page
falls back to the browser's own voice.

Rebuild from scratch:

    python3 -m venv voice/.venv
    voice/.venv/bin/pip install faster-whisper kokoro-onnx piper-tts openwakeword soundfile numpy certifi
    cd voice/models
    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
    SSL_CERT_FILE=$(../.venv/bin/python -c 'import certifi;print(certifi.where())') \
      ../.venv/bin/python -m piper.download_voices --data-dir . en_GB-alan-medium
    ../.venv/bin/python -c 'import openwakeword.utils as u; u.download_models(model_names=["hey_jarvis"])'

Settings (environment): JARVIS_WHISPER_MODEL (small.en), JARVIS_KOKORO_VOICE
(bm_george), JARVIS_PIPER_VOICE, JARVIS_WAKE_THRESHOLD (0.5).
