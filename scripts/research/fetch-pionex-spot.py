"""Fetch public Binance spot monthly archives; never touches the project DB."""
import csv
import hashlib
import io
import json
import pathlib
import sys
import urllib.request
import zipfile

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/private/tmp/pionex-spot-research")
out.mkdir(parents=True, exist_ok=True)
months = sys.argv[2:] or ["2026-01", "2026-02", "2026-03", "2026-04", "2022-05", "2022-11", "2025-01", "2025-02"]
manifest = []
for month in months:
    filename = f"ETHUSDT-1m-{month}.zip"
    url = f"https://data.binance.vision/data/spot/monthly/klines/ETHUSDT/1m/{filename}"
    archive = out / filename
    if not archive.exists():
        with urllib.request.urlopen(url, timeout=30) as response:
            archive.write_bytes(response.read())
    raw = archive.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    checksum = out / (filename + ".CHECKSUM")
    if not checksum.exists():
        with urllib.request.urlopen(url + ".CHECKSUM", timeout=30) as response:
            checksum.write_bytes(response.read())
    assert digest == checksum.read_text().split()[0], f"checksum mismatch: {filename}"
    candles = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        with z.open(z.namelist()[0]) as f:
            for row in csv.reader(io.TextIOWrapper(f)):
                ts = int(row[0])
                # Official archives use microseconds for spot from 2025-01-01.
                seconds = ts // (1_000_000 if ts > 10**14 else 1000)
                candles.append(dict(timestamp=seconds, open=float(row[1]), high=float(row[2]), low=float(row[3]), close=float(row[4]), volume=float(row[5])))
    assert all(b["timestamp"] - a["timestamp"] == 60 for a, b in zip(candles, candles[1:])), f"minute gap: {month}"
    (out / f"{month}.json").write_text(json.dumps(candles, separators=(",", ":")))
    manifest.append(dict(month=month, url=url, sha256=digest, minutes=len(candles)))
    print(json.dumps(manifest[-1]), flush=True)
(out / "manifest.json").write_text(json.dumps(manifest, indent=2))
