#!/usr/bin/env python3
"""Erzeugt die leisen HELIX-Klänge (Klick, Erfolg, Fehler, Installer fertig) als WAV und MP3.

Bewusst dezent: kurze, weiche Sinustöne ohne Hall und ohne Rauschen, leise ausgesteuert.
Aufruf:  python3 scripts/make-soft-sounds.py <ordner-app-sfx> <ordner-installer-assets>
"""
import os
import subprocess
import sys
import wave

import numpy as np

SR = 44100


def tone(freq, dur, attack=0.004, tau=0.06, partial=0.18):
    x = np.arange(int(SR * dur)) / SR
    env = np.minimum(1, x / attack) * np.exp(-x / tau)
    sig = np.sin(2 * np.pi * freq * x) + partial * np.sin(2 * np.pi * freq * 2 * x)
    return sig * env


def seq(*parts, gap=0.0):
    out = []
    for i, p in enumerate(parts):
        out.append(p)
        if gap and i < len(parts) - 1:
            out.append(np.zeros(int(SR * gap)))
    return np.concatenate(out)


def overlap(a, b, offset):
    n = max(len(a), int(SR * offset) + len(b))
    out = np.zeros(n)
    out[:len(a)] += a
    out[int(SR * offset):int(SR * offset) + len(b)] += b
    return out


def level(sig, dbfs):
    peak = np.max(np.abs(sig)) or 1
    return sig / peak * (10 ** (dbfs / 20))


def fade_out(sig, ms=12):
    n = int(SR * ms / 1000)
    sig[-n:] *= np.linspace(1, 0, n)
    return sig


def write_wav(path, sig):
    data = (np.clip(sig, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def to_mp3(wav, mp3):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '96k', mp3], check=True)


SOUNDS = {
    # kurzer, weicher Tipp
    'click': lambda: fade_out(level(tone(1320, 0.05, tau=0.012, partial=0.1), -22)),
    # zwei helle, leise Töne nach oben
    'success': lambda: fade_out(level(overlap(tone(880, 0.22, tau=0.07), tone(1318.5, 0.3, tau=0.09), 0.075), -20)),
    # zwei weiche Töne nach unten
    'error': lambda: fade_out(level(overlap(tone(523.25, 0.22, tau=0.08, partial=0.05), tone(392, 0.3, tau=0.1, partial=0.05), 0.09), -20)),
}

INSTALLER = {
    # Setup fertig: drei leise Töne
    'done': lambda: fade_out(level(overlap(overlap(tone(659.25, 0.3, tau=0.09), tone(880, 0.3, tau=0.09), 0.09), tone(1318.5, 0.45, tau=0.14), 0.18), -18)),
    'click': SOUNDS['click'],
}


def main():
    app_dir = sys.argv[1] if len(sys.argv) > 1 else 'src/renderer/assets/sfx'
    inst_dir = sys.argv[2] if len(sys.argv) > 2 else 'installer/assets'
    os.makedirs(app_dir, exist_ok=True)
    for name, make in SOUNDS.items():
        wav = os.path.join(app_dir, f'{name}.wav')
        write_wav(wav, make())
        to_mp3(wav, os.path.join(app_dir, f'{name}.mp3'))
        os.remove(wav)
    os.makedirs(inst_dir, exist_ok=True)
    for name, make in INSTALLER.items():
        write_wav(os.path.join(inst_dir, f'{name}.wav'), make())
    print('ok')


if __name__ == '__main__':
    main()
