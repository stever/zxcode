#!/usr/bin/env bash
# Rebuilds the sjasmplus ports of the Threetwosevensixseven/
# ZXSpectrumNextTests sources into the vendored .nex fixtures one
# directory up. Requires sjasmplus 1.21+ (https://github.com/z00m128/sjasmplus).
set -euo pipefail
cd "$(dirname "$0")"

sjasmplus --zxnext MMUPaging.asm
sjasmplus --zxnext -DSTANDARD MMUPaging.asm
sjasmplus --zxnext DFFDPaging.asm
for o in 0 1 2 3 4 5; do
    sjasmplus --zxnext -DORDER=$o Level2Order.asm
    mv Level2Order.nex "Level2Order_$o.nex"
done
for m in 0 1 2; do
    sjasmplus --zxnext -DMODE=$m ULAScreenPaging.asm
done

mv -f ./*.nex ..
echo "rebuilt into $(cd .. && pwd)"
