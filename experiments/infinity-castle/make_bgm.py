"""Synthesise an 8 s score for the fall animation: biwa, taiko, drone and fall-speed wind.

    python3 make_bgm.py        -> renders/bgm.wav
"""
import math
import os
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'renders', 'bgm.wav')
SR = 48000
FPS, FRAMES = 24, 192
DUR = FRAMES / FPS
N = int(SR * DUR)
T = np.arange(N) / SR
rng = np.random.default_rng(7)


def smooth01(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def fall_speed():
    """Same speed curve as build_infinity_castle._fall_profile, resampled to audio rate."""
    t = np.linspace(0, 1, FRAMES)
    v = np.maximum(smooth01(t / 0.22), 0.04) * (1.0 - 0.72 * smooth01((t - 0.72) / 0.28))
    v /= v.max()
    return np.interp(T, t * DUR, v)


def hz(note):
    names = {'C': -9, 'C#': -8, 'D': -7, 'D#': -6, 'Eb': -6, 'E': -5, 'F': -4, 'F#': -3,
             'G': -2, 'G#': -1, 'Ab': -1, 'A': 0, 'A#': 1, 'Bb': 1, 'B': 2}
    return 440.0 * 2 ** ((names[note[:-1]] + 12 * (int(note[-1]) - 4)) / 12)


def biwa(freq, dur, amp=1.0, bright=0.7):
    """Karplus-Strong pluck with a buzzing 'sawari' bridge."""
    n = int(SR * dur)
    p = max(2, int(SR / freq))
    buf = rng.uniform(-1, 1, p) * np.linspace(1, bright, p)
    y = np.zeros(n)
    y[:p] = buf
    decay = 0.996 ** (220.0 / freq)
    i = p
    while i < n:
        j = min(i + p, n)
        prev = y[i - p:j - p]
        prev2 = np.concatenate(([y[i - p - 1] if i - p - 1 >= 0 else 0.0], prev[:-1]))
        y[i:j] = decay * 0.5 * (prev + prev2)
        i = j
    y = np.tanh(2.4 * y + 0.25 * y * y) * 0.8          # sawari buzz: asymmetric saturation
    attack = np.minimum(1.0, np.arange(n) / (0.002 * SR))
    click = rng.uniform(-1, 1, n) * np.exp(-np.arange(n) / (0.004 * SR)) * 0.6  # plectrum
    return amp * (y * attack + click)


def taiko(dur=1.6, amp=1.0, f0=95, f1=48):
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 18)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3.2)
    skin = lowpass(rng.uniform(-1, 1, n), 900) * np.exp(-t * 30) * 1.5
    return amp * np.tanh(1.6 * (body + skin))


def lowpass(x, cutoff):
    """One-pole lowpass; cutoff may be scalar or per-sample array."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def place(track, clip, t0, pan=0.0):
    i = int(t0 * SR)
    j = min(N, i + len(clip))
    if j <= i:
        return
    l, r = math.cos((pan + 1) * math.pi / 4), math.sin((pan + 1) * math.pi / 4)
    track[0, i:j] += clip[:j - i] * l
    track[1, i:j] += clip[:j - i] * r


def reverb(x, seconds=2.8, wet=0.35):
    n = int(SR * seconds)
    t = np.arange(n) / SR
    out = np.empty_like(x)
    for ch in range(2):
        ir = rng.normal(0, 1, n) * np.exp(-t * 6.9 / seconds)
        ir = lowpass(ir, 5000)
        ir[0] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        m = len(x[ch]) + n
        size = 1 << (m - 1).bit_length()
        y = np.fft.irfft(np.fft.rfft(x[ch], size) * np.fft.rfft(ir, size), size)[:len(x[ch])]
        out[ch] = x[ch] * (1 - wet) + y * wet * 2.2
    return out


def main():
    speed = fall_speed()
    mus = np.zeros((2, N))
    fx = np.zeros((2, N))

    # low drone on D, swelling as the fall deepens
    env = 0.25 + 0.55 * smooth01(T / 5.5) - 0.2 * smooth01((T - 6.5) / 1.5)
    drone = (np.sin(2 * np.pi * hz('D1') * T) + 0.5 * np.sin(2 * np.pi * hz('D2') * T + 0.3)
             + 0.25 * np.sin(2 * np.pi * hz('A2') * T * 1.002))
    drone = drone * env * 0.22
    mus += np.stack([drone, drone * 0.97])

    # opening strike: the biwa note that drops you into the castle
    place(mus, biwa(hz('D3'), 4.0, 0.9) + biwa(hz('A3'), 4.0, 0.6), 0.0, -0.2)
    place(mus, biwa(hz('D2'), 4.0, 0.7, bright=0.5), 0.02, 0.2)

    # falling phrase in miyako-bushi (D Eb G A Bb), stepping down as speed rises
    phrase = [('Bb4', 1.80), ('A4', 2.25), ('G4', 2.55), ('Eb4', 2.95), ('D4', 3.30),
              ('Bb3', 3.80), ('A3', 4.10), ('G3', 4.45), ('Eb3', 4.85), ('D3', 5.30)]
    for k, (note, t0) in enumerate(phrase):
        pan = 0.5 * math.sin(k * 1.3)
        place(mus, biwa(hz(note), 2.2, 0.45 + 0.03 * k), t0, pan)
        if k in (4, 9):   # tremolo flourish
            for r in range(4):
                place(mus, biwa(hz(note), 0.6, 0.18), t0 + 0.07 * (r + 1), -pan)

    # taiko: sparse hits into a crescendo, then the big one at the float
    for t0, a in [(1.0, 0.7), (2.0, 0.75), (3.0, 0.8), (3.75, 0.7), (4.25, 0.75),
                  (4.6, 0.8), (4.9, 0.85), (5.15, 0.9), (5.35, 0.95)]:
        place(mus, taiko(amp=a), t0, rng.uniform(-0.3, 0.3))
    place(mus, taiko(dur=2.5, amp=1.2, f0=80, f1=38), 6.1, 0.0)

    # final strike when the camera slows and looks out
    place(mus, biwa(hz('D2'), 2.4, 0.9, bright=0.55) + biwa(hz('A2'), 2.4, 0.6), 6.15, -0.1)
    place(mus, biwa(hz('Eb3'), 2.2, 0.35), 6.55, 0.4)

    # wind: noise whose loudness and brightness follow fall speed, swirling with the camera spin
    noise = rng.normal(0, 1, N)
    wind = lowpass(noise, 250 + 2600 * speed ** 1.5) * (0.05 + 0.9 * speed ** 2)
    rumble = lowpass(rng.normal(0, 1, N), 90) * speed * 1.4
    spin = np.sin(2 * np.pi * 0.35 * T * (0.5 + speed))
    fx[0] += (wind + rumble) * (0.75 + 0.25 * spin)
    fx[1] += (wind + rumble) * (0.75 - 0.25 * spin)

    # fly-by whooshes: things rushing past close to the camera
    for t0, pan in [(1.6, -0.8), (2.7, 0.7), (3.5, -0.5), (4.3, 0.9), (5.0, -0.7)]:
        n = int(SR * 0.9)
        tt = np.arange(n) / SR
        shape = np.exp(-((tt - 0.45) / 0.16) ** 2)
        w = lowpass(rng.normal(0, 1, n), 600 + 3000 * shape) * shape * 0.9
        place(fx, w, t0 - 0.45, pan)

    mix = reverb(mus, 3.2, 0.4) + reverb(fx, 1.2, 0.2) * 0.8
    fade = np.minimum(1.0, (DUR - T) / 0.35) * np.minimum(1.0, T / 0.01)
    mix *= fade
    mix = np.tanh(mix / np.max(np.abs(mix)) * 1.3) * 0.89

    pcm = (mix.T * 32767).astype(np.int16)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with wave.open(OUT, 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(pcm.tobytes())
    print('WROTE', OUT, round(DUR, 2), 's')


if __name__ == '__main__':
    main()
