#!/usr/bin/env python3
"""Erzeugt die eigenen HELIX-Klänge (Programm + Installer) als WAV/MP3.

Alle Klänge sind hier von Grund auf synthetisiert (Sinus, FM-Glocken, gefiltertes Rauschen,
Hall) – keine fremden Samples. Aufruf:  python3 scripts/make-sounds.py <ausgabeordner> [ffmpeg]
"""
import os
import subprocess
import sys
import wave

import numpy as np

SR = 44100
rng = np.random.default_rng(7)


def t(sec):
    return np.arange(int(SR * sec)) / SR


def env_adsr(n, a=0.005, d=0.05, s=0.6, r=0.2, sustain_len=None):
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    s_n = max(0, n - a_n - d_n - r_n) if sustain_len is None else int(sustain_len * SR)
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(s_n, s),
        np.linspace(s, 0, r_n),
    ])
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def exp_decay(n, tau):
    return np.exp(-np.arange(n) / (tau * SR))


def bell(freq, dur, ratio=3.5, index=2.0, tau=0.35):
    x = t(dur)
    mod_env = exp_decay(len(x), tau * 0.6)
    return np.sin(2 * np.pi * freq * x + index * mod_env * np.sin(2 * np.pi * freq * ratio * x)) * exp_decay(len(x), tau)


def lowpass(sig, cutoff):
    # einfacher Einpol-Tiefpass, cutoff darf ein Array sein (Filterfahrt)
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=float), sig.shape)
    out = np.zeros_like(sig)
    y = 0.0
    k = 1 - np.exp(-2 * np.pi * cutoff / SR)
    for i in range(len(sig)):
        y += k[i] * (sig[i] - y)
        out[i] = y
    return out


def highpass(sig, cutoff):
    return sig - lowpass(sig, cutoff)


def reverb(sig, mix=0.3, length=1.6, seed=3):
    r = np.random.default_rng(seed)
    n = int(length * SR)
    ir = r.standard_normal(n) * np.exp(-np.arange(n) / (length * SR / 5.5))
    ir = lowpass(ir, 6000)
    ir[0] = 0
    wet = np.convolve(sig, ir)
    wet = np.pad(wet, (0, len(sig) + n - len(wet)))
    wet /= np.max(np.abs(wet)) + 1e-9
    dry = np.pad(sig, (0, n))
    return (1 - mix) * dry + mix * wet * np.max(np.abs(sig))


def stereo(sig, width=0.0, delay_ms=9):
    d = int(delay_ms * SR / 1000)
    right = np.pad(sig, (d, 0))[: len(sig)] if width else sig
    left = sig
    return np.stack([left * (1 - width * 0.3) + right * width * 0.3, right * (1 - width * 0.3) + left * width * 0.3], axis=1)


def norm(sig, peak=0.89):
    m = np.max(np.abs(sig)) + 1e-9
    return sig / m * peak


def fade(sig, fin=0.003, fout=0.02):
    n = len(sig)
    e = np.ones(n)
    a, b = int(fin * SR), int(fout * SR)
    if a: e[:a] = np.linspace(0, 1, a)
    if b: e[-b:] = np.linspace(1, 0, b)
    return sig * (e if sig.ndim == 1 else e[:, None])


def write_wav(path, sig):
    if sig.ndim == 1:
        sig = np.stack([sig, sig], axis=1)
    data = (np.clip(sig, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


# ---------------------------------------------------------------- Klänge

def s_hover():
    x = t(0.07)
    s = np.sin(2 * np.pi * 2600 * x) * exp_decay(len(x), 0.012) + 0.4 * np.sin(2 * np.pi * 3900 * x) * exp_decay(len(x), 0.008)
    return fade(norm(s, 0.5), 0.001, 0.01)


def s_click():
    s = bell(1320, 0.22, ratio=2.01, index=1.2, tau=0.05) + 0.5 * bell(1980, 0.22, ratio=1.5, index=0.6, tau=0.035)
    noise = highpass(rng.standard_normal(len(s)), 3000) * exp_decay(len(s), 0.004) * 0.25
    return fade(norm(reverb(s + noise, 0.18, 0.5), 0.7))


def s_whoosh(dur=1.3):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    pos = np.linspace(0, 1, n)
    sweep = 400 + 5200 * np.sin(np.pi * pos) ** 2
    body = lowpass(highpass(noise, 250), sweep) * np.sin(np.pi * pos) ** 1.5
    sub = np.sin(2 * np.pi * (55 + 30 * pos) * t(dur)) * np.sin(np.pi * pos) ** 2 * 0.6
    shimmer = sum(bell(f, dur, ratio=2.7, index=1.0, tau=0.5) for f in (1760, 2637)) * np.clip((pos - 0.35) * 3, 0, 1) * 0.08
    s = body + sub + shimmer
    return fade(norm(reverb(s, 0.25, 1.2), 0.85), 0.01, 0.15)


def fit(x, n, start=0):
    x = np.pad(x, (start, 0))
    return np.pad(x, (0, max(0, n - len(x))))[:n]


def s_success():
    n = int(1.4 * SR)
    a = fit(bell(880, 1.4, ratio=3.01, index=1.4, tau=0.45), n)
    b = fit(bell(1318.5, 1.25, ratio=3.01, index=1.4, tau=0.5), n, int(0.11 * SR))
    c = fit(bell(1760, 1.15, ratio=2.0, index=0.8, tau=0.55), n, int(0.22 * SR))
    s = a * 0.7 + b * 0.6 + c * 0.45
    return fade(norm(reverb(s, 0.35, 1.8), 0.75))


def s_error():
    x = t(0.42)
    f = np.where(x < 0.18, 233, 196)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * (np.where(x < 0.18, 1, 0.9)) * env_adsr(len(x), 0.004, 0.05, 0.5, 0.12)
    s += 0.3 * np.sin(2 * np.pi * np.cumsum(f * 2.01) / SR) * env_adsr(len(x), 0.004, 0.05, 0.3, 0.1)
    gate = np.where((x > 0.16) & (x < 0.2), 0.2, 1.0)
    return fade(norm(reverb(lowpass(s * gate, 2500), 0.15, 0.6), 0.6))


def pad_chord(dur, freqs, detune=0.4, bright=1800):
    x = t(dur)
    out = np.zeros(len(x))
    for f in freqs:
        for d in (-detune, 0, detune):
            ph = rng.uniform(0, 2 * np.pi)
            saw = 2 * ((x * (f + d) + ph / (2 * np.pi)) % 1) - 1
            out += saw
    return lowpass(out / (len(freqs) * 3), bright)


def s_intro(dur=6.0, hit_at=3.6, chord=(110, 164.81, 220, 329.63), bells=(1760, 2217.46, 2637, 3520)):
    n = int(dur * SR)
    pos = np.linspace(0, 1, n)
    # Aufbau: Rauschen + steigender Ton, dann Einschlag, danach schimmernde Fläche
    riser_noise = lowpass(highpass(rng.standard_normal(n), 400), 300 + 7000 * pos ** 2) * np.clip(pos / (hit_at / dur), 0, 1) ** 2.2
    riser_noise *= (t(dur) < hit_at)
    riser_tone = np.sin(2 * np.pi * np.cumsum(110 + 330 * np.clip(pos / (hit_at / dur), 0, 1) ** 2) / SR) * 0.25 * np.clip(pos / (hit_at / dur), 0, 1) ** 2 * (t(dur) < hit_at)
    hit = np.zeros(n)
    h0 = int(hit_at * SR)
    hx = t(dur - hit_at)
    boom = np.sin(2 * np.pi * (48 + 60 * np.exp(-hx * 18)) * hx) * exp_decay(len(hx), 0.9)
    crack = highpass(rng.standard_normal(len(hx)), 1500) * exp_decay(len(hx), 0.05) * 0.5
    hit[h0:] = boom + crack
    pad = pad_chord(dur, list(chord), bright=2200) * np.clip((pos - hit_at / dur + 0.05) * 4, 0, 1) * 0.5
    sparkle = np.zeros(n)
    for i, f in enumerate(bells):
        b = bell(f, dur - hit_at - 0.1 * i, ratio=2.0, index=0.7, tau=0.9) * 0.12
        start = h0 + int(0.12 * i * SR)
        sparkle[start:start + len(b)] += b[: n - start]
    s = riser_noise * 0.6 + riser_tone + hit * 0.9 + pad + sparkle
    s = reverb(s, 0.3, 2.4)[:n]
    return fade(norm(stereo(s, 0.8, 11), 0.9), 0.05, 0.8)


def s_install_loop(dur=16.0):
    # ruhige, nahtlose Fläche für den Installer (Länge = 2 Takte, endet wie sie beginnt)
    x = t(dur)
    chords = [[110, 164.81, 246.94, 329.63], [98, 146.83, 220, 329.63]]
    half = len(x) // 2
    out = np.zeros(len(x))
    for i, ch in enumerate(chords):
        seg = pad_chord(dur / 2 + 1.0, ch, detune=0.6, bright=1400)
        e = np.sin(np.linspace(0, np.pi, len(seg))) ** 0.8
        start = i * half - int(0.5 * SR)
        a, b = max(0, start), min(len(x), start + len(seg))
        out[a:b] += (seg * e)[a - start:b - start]
    # Rest des zweiten Akkords an den Anfang legen -> Schleife ohne Naht
    seg = pad_chord(dur / 2 + 1.0, chords[1], detune=0.6, bright=1400)
    e = np.sin(np.linspace(0, np.pi, len(seg))) ** 0.8
    tail = (seg * e)[len(x) - (half - int(0.5 * SR)):]
    out[: len(tail)] += tail[: len(x)]
    lfo = 0.85 + 0.15 * np.sin(2 * np.pi * x / dur * 4)
    shimmer = sum(np.sin(2 * np.pi * f * x) * (0.5 + 0.5 * np.sin(2 * np.pi * x / dur * k + k)) for k, f in enumerate([659.25, 987.77, 1318.5], start=1)) * 0.03
    s = out * lfo + shimmer
    s = reverb(s, 0.35, 2.0)[: len(x)]
    return norm(stereo(s, 0.9, 13), 0.55)


def s_install_done():
    notes = [523.25, 659.25, 783.99, 1046.5]
    n = int(2.6 * SR)
    s = np.zeros(n)
    for i, f in enumerate(notes):
        b = bell(f, 2.6 - 0.09 * i, ratio=3.0, index=1.2, tau=0.7)
        st = int(0.09 * i * SR)
        s[st:st + len(b)] += b[: n - st] * (0.8 - 0.1 * i)
    pad = pad_chord(2.6, [261.63, 392, 523.25], bright=2500) * env_adsr(n, 0.05, 0.3, 0.4, 1.2) * 0.4
    s = reverb(s + pad, 0.35, 2.0)[:n]
    return fade(norm(stereo(s, 0.7), 0.8), 0.005, 0.5)


def s_install_intro():
    return s_intro(6.0, 4.0, (98, 146.83, 196, 293.66), (1567.98, 1975.53, 2349.32, 3135.96))


SOUNDS = {
    'install-intro': s_install_intro,
    'hover': s_hover,
    'click': s_click,
    'whoosh': s_whoosh,
    'success': s_success,
    'error': s_error,
    'intro': s_intro,
    'install-loop': s_install_loop,
    'install-done': s_install_done,
}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'build/sfx'
    ffmpeg = sys.argv[2] if len(sys.argv) > 2 else None
    os.makedirs(out, exist_ok=True)
    for name, fn in SOUNDS.items():
        sig = fn()
        wav = os.path.join(out, f'{name}.wav')
        write_wav(wav, sig)
        if ffmpeg:
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '3', os.path.join(out, f'{name}.mp3')], check=True)
        print(name, f'{len(sig) / SR:.2f}s')


if __name__ == '__main__':
    main()
