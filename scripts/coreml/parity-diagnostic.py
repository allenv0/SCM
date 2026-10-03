#!/usr/bin/env python3
"""Compare CPU-q8 vs CoreML-fp16 vs CoreML-fp32 vs PyTorch-HF reference.

Separates:
  - q8-ONNX vs HF-fp32 weights  (baseline export/quantization drift)
  - HF-fp32 vs CoreML-fp16      (conversion + fp16 compute drift)
  - HF-fp32 vs CoreML-fp32      (conversion-only drift)
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
BASE = OUT / "baseline"


def load_vec_json(p: Path):
    return json.loads(p.read_text())


def norm(v):
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else v


def cos(a, b):
    return sum(x * y for x, y in zip(a, b))


def load_tensor(p: Path):
    raw = p.read_bytes()
    n = len(raw) // 4
    return list(struct.unpack(f"<{n}f", raw))


def summarize(name, pairs):
    xs = sorted(pairs)
    if not xs:
        print(f"{name}: empty")
        return
    mid = xs[len(xs) // 2]
    print(
        f"{name}: n={len(xs)} min={xs[0]:.6f} med={mid:.6f} max={xs[-1]:.6f}"
    )


def main():
    nv = load_vec_json(OUT / "native-vectors-ne.json")
    nat_ne = {v["id"]: v["vec"] for v in nv["vectors"]}
    fp32_path = OUT / "native-vectors-fp32.json"
    nat_f32 = {}
    if fp32_path.exists():
        nv32 = load_vec_json(fp32_path)
        nat_f32 = {v["id"]: v["vec"] for v in nv32["vectors"]}

    ids = []
    cpu = {}
    for p in sorted(BASE.glob("*.json")):
        if p.name in ("index.json", "queries.json"):
            continue
        d = load_vec_json(p)
        cpu[d["id"]] = d["cpuQ8"]["normalized"]
        ids.append(d["id"])

    # PyTorch HF reference on the same pixel_values
    import torch
    from transformers import SiglipVisionModel

    print("[ref] loading SiglipVisionModel @ pinned revision …")
    model = SiglipVisionModel.from_pretrained(
        "google/siglip2-base-patch16-224",
        revision="75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2",
    )
    model.eval()
    hf = {}
    with torch.no_grad():
        for i, id_ in enumerate(ids):
            x = load_tensor(BASE / "tensors" / f"{id_}.f32")
            t = torch.tensor(x, dtype=torch.float32).reshape(1, 3, 224, 224)
            y = model(pixel_values=t).pooler_output[0].tolist()
            hf[id_] = y
            if (i + 1) % 16 == 0:
                print(f"[ref] {i+1}/{len(ids)}")

    cpu_vs_ne = []
    cpu_vs_f32 = []
    cpu_vs_hf = []
    hf_vs_ne = []
    hf_vs_f32 = []
    ne_vs_f32 = []
    for id_ in ids:
        c = norm(cpu[id_])
        cpu_vs_ne.append(cos(c, norm(nat_ne[id_])))
        cpu_vs_hf.append(cos(c, norm(hf[id_])))
        hf_vs_ne.append(cos(norm(hf[id_]), norm(nat_ne[id_])))
        if id_ in nat_f32:
            cpu_vs_f32.append(cos(c, norm(nat_f32[id_])))
            hf_vs_f32.append(cos(norm(hf[id_]), norm(nat_f32[id_])))
            ne_vs_f32.append(cos(norm(nat_ne[id_]), norm(nat_f32[id_])))

    print()
    summarize("CPU-q8  vs CoreML-fp16-ANE", cpu_vs_ne)
    summarize("CPU-q8  vs HF-PyTorch-fp32", cpu_vs_hf)
    summarize("HF-fp32 vs CoreML-fp16-ANE", hf_vs_ne)
    if fp32_path.exists():
        summarize("CPU-q8  vs CoreML-fp32-CPU", cpu_vs_f32)
        summarize("HF-fp32 vs CoreML-fp32-CPU", hf_vs_f32)
        summarize("CoreML-fp16 vs CoreML-fp32", ne_vs_f32)

    report = {
        "cpu_q8_vs_coreml_fp16": {
            "min": min(cpu_vs_ne) if cpu_vs_ne else None,
            "med": sorted(cpu_vs_ne)[len(cpu_vs_ne) // 2] if cpu_vs_ne else None,
        },
        "cpu_q8_vs_hf_fp32": {
            "min": min(cpu_vs_hf) if cpu_vs_hf else None,
            "med": sorted(cpu_vs_hf)[len(cpu_vs_hf) // 2] if cpu_vs_hf else None,
        },
        "hf_fp32_vs_coreml_fp16": {
            "min": min(hf_vs_ne) if hf_vs_ne else None,
            "med": sorted(hf_vs_ne)[len(hf_vs_ne) // 2] if hf_vs_ne else None,
        },
    }
    if fp32_path.exists():
        report["cpu_q8_vs_coreml_fp32"] = {
            "min": min(cpu_vs_f32) if cpu_vs_f32 else None,
            "med": sorted(cpu_vs_f32)[len(cpu_vs_f32) // 2] if cpu_vs_f32 else None,
        }
        report["hf_fp32_vs_coreml_fp32"] = {
            "min": min(hf_vs_f32) if hf_vs_f32 else None,
            "med": sorted(hf_vs_f32)[len(hf_vs_f32) // 2] if hf_vs_f32 else None,
        }
    (OUT / "parity-diagnostic.json").write_text(json.dumps(report, indent=2) + "\n")
    print("\nwrote out/parity-diagnostic.json")


if __name__ == "__main__":
    main()
