"""
JARVIS local voice service.

Replaces ElevenLabs with models that run on this machine. The bridge proxies
the page's /stt and /tts requests here, so the browser never talks to it
directly and nothing leaves the laptop.

  POST /stt?mode=wake|listen   raw audio (webm/ogg/wav) -> {"text", "wake", "score"}
  POST /tts                    {"text"}                  -> audio/wav
  GET  /health                 what is loaded

Speech to text: faster-whisper. Voice: Kokoro, with Piper as the fallback; if
both fail /tts returns 503 and the page falls back to the browser voice.
Wake word: openWakeWord "hey jarvis". In wake mode a clip that does not contain
the wake word is dropped before Whisper ever runs.

  voice/.venv/bin/python voice/server.py
"""

import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"

HOST = "127.0.0.1"
PORT = int(os.environ.get("JARVIS_VOICE_PORT", "8790"))
WHISPER_MODEL = os.environ.get("JARVIS_WHISPER_MODEL", "small.en")
KOKORO_VOICE = os.environ.get("JARVIS_KOKORO_VOICE", "bm_george")
PIPER_VOICE = os.environ.get("JARVIS_PIPER_VOICE", "en_GB-alan-medium")
WAKE_THRESHOLD = float(os.environ.get("JARVIS_WAKE_THRESHOLD", "0.5"))

# Mirrors WAKE in src/lib/voice.ts: if openWakeWord heard the phrase but Whisper
# spelled the name differently, the page's regex must still see it.
WAKE_TEXT = re.compile(r"\b(?:hey|hi|ok|okay|yo)?\s*(?:jarvis|jarvys|jervis|travis|jarv)\b", re.I)

SR = 16000
FRAME = 1280  # openWakeWord's 80 ms frame at 16 kHz


def log(msg):
    print(f"[voice] {msg}", flush=True)


# --- models ---------------------------------------------------------------

from faster_whisper import WhisperModel, decode_audio  # noqa: E402

whisper = WhisperModel(
    WHISPER_MODEL, device="cpu", compute_type="int8",
    download_root=str(MODELS / "whisper"), cpu_threads=8,
)
log(f"stt faster-whisper {WHISPER_MODEL}")

kokoro = None
try:
    from kokoro_onnx import Kokoro
    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    log(f"tts kokoro {KOKORO_VOICE}")
except Exception as e:  # Piper covers it
    log(f"kokoro unavailable: {e}")

piper = None
try:
    from piper import PiperVoice
    piper = PiperVoice.load(str(MODELS / f"{PIPER_VOICE}.onnx"))
    log(f"tts fallback piper {PIPER_VOICE}")
except Exception as e:
    log(f"piper unavailable: {e}")

from openwakeword.model import Model as WakeModel  # noqa: E402

wake_model = WakeModel(wakeword_models=["hey_jarvis"], inference_framework="onnx")
wake_lock = threading.Lock()  # the model keeps streaming state; one clip at a time
log(f"wake openWakeWord hey_jarvis (threshold {WAKE_THRESHOLD})")


# --- work -----------------------------------------------------------------

def to_pcm(audio_bytes):
    """Any container the browser's MediaRecorder produces -> 16 kHz mono float32."""
    return decode_audio(io.BytesIO(audio_bytes), sampling_rate=SR)


def wake_score(pcm):
    # Pad both ends: the detector needs a little context before the phrase and
    # a few frames after it to reach its peak.
    padded = np.concatenate([np.zeros(SR, np.float32), pcm, np.zeros(SR // 2, np.float32)])
    ints = (np.clip(padded, -1, 1) * 32767).astype(np.int16)
    best = 0.0
    with wake_lock:
        wake_model.reset()
        for i in range(0, len(ints) - FRAME + 1, FRAME):
            score = wake_model.predict(ints[i:i + FRAME]).get("hey_jarvis", 0.0)
            best = max(best, float(score))
    return best


def transcribe(pcm):
    segments, _ = whisper.transcribe(
        pcm, language="en", beam_size=1, vad_filter=False,
        condition_on_previous_text=False, initial_prompt="Hey Jarvis.",
    )
    return " ".join(s.text.strip() for s in segments).strip()


def stt(audio_bytes, mode):
    pcm = to_pcm(audio_bytes)
    if pcm.size < SR // 5:
        return {"text": "", "wake": False, "score": 0.0}
    score = None
    if mode == "wake":
        score = wake_score(pcm)
        if score < WAKE_THRESHOLD:
            return {"text": "", "wake": False, "score": round(score, 3)}
    text = transcribe(pcm)
    if mode == "wake" and not WAKE_TEXT.search(text):
        text = f"Hey Jarvis, {text}".strip().rstrip(",")
    return {"text": text, "wake": mode == "wake", "score": None if score is None else round(score, 3)}


def wav_bytes(samples, rate):
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def tts(text):
    if kokoro is not None:
        try:
            samples, rate = kokoro.create(text, voice=KOKORO_VOICE, speed=1.0, lang="en-gb")
            return wav_bytes(samples, rate), "kokoro"
        except Exception as e:
            log(f"kokoro failed, trying piper: {e}")
    if piper is not None:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            piper.synthesize_wav(text, w)
        return buf.getvalue(), "piper"
    raise RuntimeError("no local voice available")


# --- http -----------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self, limit):
        n = int(self.headers.get("content-length") or 0)
        if n > limit:
            raise ValueError("too large")
        return self.rfile.read(n)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {
                "ok": True, "stt": True, "wake": True,
                "tts": kokoro is not None or piper is not None,
                "engines": {"stt": f"faster-whisper {WHISPER_MODEL}",
                            "tts": "kokoro" if kokoro else ("piper" if piper else None),
                            "tts_fallback": "piper" if (kokoro and piper) else None,
                            "wake": "openWakeWord hey_jarvis"},
            })
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        t0 = time.time()
        try:
            if self.path.startswith("/stt"):
                mode = "wake" if "mode=wake" in self.path else "listen"
                out = stt(self.body(25 * 1024 * 1024), mode)
                log(f"stt {mode} {int((time.time() - t0) * 1000)}ms score={out['score']} {out['text'][:60]!r}")
                return self.reply(200, out)
            if self.path == "/tts":
                text = (json.loads(self.body(64 * 1024) or b"{}").get("text") or "").strip()
                if not text:
                    return self.reply(400, {"error": "no text"})
                audio, engine = tts(text)
                log(f"tts {engine} {int((time.time() - t0) * 1000)}ms {text[:60]!r}")
                return self.reply(200, audio, "audio/wav")
            self.reply(404, {"error": "not found"})
        except Exception as e:
            log(f"error on {self.path}: {e}")
            self.reply(503, {"error": str(e)})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
