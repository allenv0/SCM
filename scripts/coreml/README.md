# scripts/coreml — Phase 3A native CoreML vision spike

Isolated spike tree for `MDs/Plans/CoreML-Native-Spike-3A-2026-09-25.md`.
**Verdict: NEGATIVE** — see `MDs/CoreML-Native-Spike-Verdict-2026-09-25.md`.
Stage D (sidecar / E2E) was **not implemented**: kill rule at G1a (plan §7).

## Layout

| Path | Role |
|---|---|
| `requirements.txt` | Exact conversion pins |
| `setup-venv.sh` | Builds `out/venv/` |
| `preflight.sh` | Stage 0 checks |
| `export-vision.py` | HF → CoreML ML Program + `export-manifest.json` |
| `build-fixtures.js` | Fixture corpus + `fixtures/manifest.json` |
| `bench-standalone.swift` | Stage B native bench |
| `dump-baseline.js` | CPU-q8 tensors + vectors |
| `dump-vectors.swift` | Native vector dump |
| `parity.js` | G1a / G1b |
| `parity-diagnostic.py` | fp32 + HF reference isolation |
| `out/` | Generated (gitignored) |

## Re-run

```bash
bash scripts/coreml/setup-venv.sh
node scripts/coreml/build-fixtures.js
bash scripts/coreml/preflight.sh
scripts/coreml/out/venv/bin/python scripts/coreml/export-vision.py --out scripts/coreml/out
swiftc -O -parse-as-library -o scripts/coreml/out/bench-standalone scripts/coreml/bench-standalone.swift
scripts/coreml/out/bench-standalone \
  --model scripts/coreml/out/siglip2-vision-fp16.mlpackage \
  --iters 50 --warmup 4 --compute-units cpu-neural-engine \
  --input scripts/coreml/out/baseline/tensors/smoke-synthetic.f32
node scripts/coreml/dump-baseline.js
swiftc -O -parse-as-library -o scripts/coreml/out/dump-vectors scripts/coreml/dump-vectors.swift
scripts/coreml/out/dump-vectors \
  --model scripts/coreml/out/siglip2-vision-fp16.mlpackage \
  --compute-units cpu-neural-engine \
  --tensors scripts/coreml/out/baseline/tensors \
  --out scripts/coreml/out/native-vectors-ne.json
node scripts/coreml/parity.js
```

## Key measured facts (2026-09-25, M1)

- ANE p50 **9.05 ms** (cpu-only 22.4 ms) — Stage B early-stop not triggered
- G1a min cosine vs CPU-q8 **0.669** (kill bar 0.99)
- CoreML ≡ HF PyTorch (min cos 1.0 fp32 / 0.998 fp16); CPU-q8 ONNX ≈ HF only 0.669
