#!/usr/bin/env bash
# Macht aus einem Higgsfield-Clip einen nahtlosen Loop (Ende blendet in den Anfang über).
# loop-video.sh <ffmpeg> <eingang.mp4> <ausgang.mp4> <breite> <höhe> [überblendung_s] [schwarz_anheben]
set -euo pipefail
FF="$1"; IN="$2"; OUT="$3"; W="$4"; H="$5"; X="${6:-1}"; BL="${7:-0.035}"
D=$( ("$FF" -i "$IN" 2>&1 || true) | grep Duration | sed -E 's/.*Duration: ([0-9]+):([0-9]+):([0-9.]+).*/\1 \2 \3/' | awk '{print $1*3600+$2*60+$3}')
OFF=$(python3 -c "print(round($D-2*$X,3))")
"$FF" -hide_banner -loglevel error -y -i "$IN" -filter_complex \
  "[0:v]split[s1][s2];[s1]trim=$X:$D,setpts=PTS-STARTPTS,fps=24,settb=AVTB[a];[s2]trim=0:$X,setpts=PTS-STARTPTS,fps=24,settb=AVTB[b];[a][b]xfade=transition=fade:duration=$X:offset=$OFF,colorlevels=rimin=$BL:gimin=$BL:bimin=$BL,scale=$W:$H:flags=lanczos,format=yuv420p" \
  -an -c:v libx264 -preset slow -crf 22 -movflags +faststart "$OUT"
