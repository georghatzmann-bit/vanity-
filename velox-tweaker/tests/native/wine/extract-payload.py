#!/usr/bin/env python3
"""Pulls the embedded managed resource "payload.zip" out of VeloxSetup.exe (or Uninstall.exe).

    python3 -I extract-payload.py <VeloxSetup.exe> <out.zip>

A .NET manifest resource is stored as <uint32 length><bytes>. The payload is the zip whose length
prefix sits right before a local file header and whose end-of-central-directory record ends exactly
at offset + length. Used by tests/native/wine-smoke.sh to compare the installed files byte by byte
with what the installer carries, independently of the installer's own file list.
"""
import io
import struct
import sys
import zipfile


def main(exe_path, out_path):
    data = open(exe_path, "rb").read()
    best = None
    pos = data.find(b"PK\x03\x04")
    while pos != -1:
        if pos >= 4:
            (length,) = struct.unpack_from("<I", data, pos - 4)
            end = pos + length
            if 22 <= length and end <= len(data) and data.rfind(b"PK\x05\x06", pos, end) >= end - 22 - 0xFFFF:
                blob = data[pos:end]
                try:
                    with zipfile.ZipFile(io.BytesIO(blob)) as z:
                        names = z.namelist()
                    if "VELOX.exe" in names and (best is None or len(blob) > len(best)):
                        best = blob
                except zipfile.BadZipFile:
                    pass
        pos = data.find(b"PK\x03\x04", pos + 4)
    if best is None:
        print("payload.zip not found in " + exe_path, file=sys.stderr)
        return 1
    with open(out_path, "wb") as f:
        f.write(best)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
