#!/usr/bin/env python3
"""Pinned SigLIP-2 vision → CoreML ML Program export (Phase 3A Stage A).

Contract (MDs/Plans/CoreML-Native-Spike-3A-2026-09-25.md §3):
  - source revision is immutable (PINNED_REVISION)
  - thin wrapper returns ONLY outputs.pooler_output
  - ML Program, f32 boundary I/O named pixel_values / pooler_output
  - fp16 internal compute, macOS14 minimum deployment
  - writes export-manifest.json with SHA-256 of every source file
  - Python-level finite/shape smoke only — executability is Stage B's job

Usage:
  python export-vision.py --out out/ [--diagnostic-fp32]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import torch

# ---------------------------------------------------------------------------
# Locked model contract — do not broaden during this spike.
# ---------------------------------------------------------------------------
HF_REPO = "google/siglip2-base-patch16-224"
PINNED_REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
REGISTRY_ID = "siglip2-base-patch16-224"
INPUT_SHAPE = (1, 3, 224, 224)
OUTPUT_DIM = 768
INPUT_NAME = "pixel_values"
OUTPUT_NAME = "pooler_output"
MLPACKAGE_NAME = "siglip2-vision-fp16.mlpackage"
MLPACKAGE_FP32_NAME = "siglip2-vision-fp32-diagnostic.mlpackage"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def package_sha256(mlpackage: Path) -> str:
    """Stable hash over the .mlpackage directory (relative path + file bytes)."""
    h = hashlib.sha256()
    files = sorted(p for p in mlpackage.rglob("*") if p.is_file())
    for p in files:
        rel = p.relative_to(mlpackage).as_posix()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        with p.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        h.update(b"\0")
    return h.hexdigest()


def tool_versions() -> dict:
    import coremltools
    import numpy
    import torch
    import transformers

    def _ver(mod):
        return getattr(mod, "__version__", str(mod))

    return {
        "python": sys.version.split()[0],
        "torch": _ver(torch),
        "transformers": _ver(transformers),
        "coremltools": _ver(coremltools),
        "numpy": _ver(numpy),
        "platform": platform.platform(),
        "machine": platform.machine(),
    }


def git_commit(repo_root: Path) -> str | None:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo_root, text=True
        )
        return out.strip()
    except Exception:
        return None


def load_vision(hf_home: Path):
    """Load Siglip*VisionModel at the pinned revision. Returns (model, source_files)."""
    from transformers import AutoConfig, AutoModel

    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    # Prefer explicit vision classes when available; fall back to AutoModel
    # and slice .vision_model when the checkpoint is a full SigLIP(2) model.
    model = None
    load_note = None
    try:
        from transformers import Siglip2VisionModel

        model = Siglip2VisionModel.from_pretrained(HF_REPO, revision=PINNED_REVISION)
        load_note = "Siglip2VisionModel.from_pretrained"
    except Exception as e2:
        try:
            from transformers import SiglipVisionModel

            model = SiglipVisionModel.from_pretrained(HF_REPO, revision=PINNED_REVISION)
            load_note = "SiglipVisionModel.from_pretrained"
        except Exception as e1:
            try:
                full = AutoModel.from_pretrained(HF_REPO, revision=PINNED_REVISION)
                if hasattr(full, "vision_model"):
                    model = full.vision_model
                    load_note = "AutoModel.from_pretrained(...).vision_model"
                else:
                    raise RuntimeError(f"no vision tower on {type(full)}")
            except Exception as e0:
                raise RuntimeError(
                    f"failed to load vision tower: siglip2={e2}; siglip={e1}; auto={e0}"
                ) from e0

    model.eval()
    for p in model.parameters():
        p.requires_grad_(False)

    # Snapshot the downloaded source files for the manifest.
    source_files = []
    # HF cache layout: models--google--siglip2-base-patch16-224/snapshots/<rev>/
    snap = None
    hub_cache = Path(os.environ.get("HUGGINGFACE_HUB_CACHE", Path.home() / ".cache/huggingface/hub"))
    # Also honor the venv-local cache we set.
    candidates = [
        hf_home / "hub",
        hub_cache,
    ]
    for root in candidates:
        d = root / f"models--{HF_REPO.replace('/', '--')}" / "snapshots" / PINNED_REVISION
        if d.is_dir():
            snap = d
            break
    if snap is None:
        # Fall back: walk any snapshot matching the revision prefix.
        for root in candidates:
            base = root / f"models--{HF_REPO.replace('/', '--')}" / "snapshots"
            if base.is_dir():
                for child in base.iterdir():
                    if child.name.startswith(PINNED_REVISION[:12]):
                        snap = child
                        break
    if snap is not None:
        for p in sorted(snap.rglob("*")):
            if p.is_file() and not p.is_symlink():
                source_files.append(
                    {
                        "relpath": p.relative_to(snap).as_posix(),
                        "sha256": sha256_file(p),
                        "bytes": p.stat().st_size,
                    }
                )
            elif p.is_file():
                # symlink into blobs/
                real = p.resolve()
                source_files.append(
                    {
                        "relpath": p.relative_to(snap).as_posix(),
                        "sha256": sha256_file(real),
                        "bytes": real.stat().st_size,
                    }
                )
    return model, load_note, source_files, snap


class PoolerOnly(torch.nn.Module):
    """Trace wrapper: pixel_values → pooler_output only. No ModelOutput."""

    def __init__(self, vision):
        super().__init__()
        self.vision = vision

    def forward(self, pixel_values):
        outputs = self.vision(pixel_values=pixel_values)
        return outputs.pooler_output


def convert_traced(traced, out_dir: Path, name: str, compute_precision):
    import coremltools as ct
    import numpy as np

    mlmodel = ct.convert(
        traced,
        convert_to="mlprogram",
        inputs=[
            ct.TensorType(name=INPUT_NAME, shape=INPUT_SHAPE, dtype=np.float32),
        ],
        outputs=[
            ct.TensorType(name=OUTPUT_NAME, dtype=np.float32),
        ],
        compute_precision=compute_precision,
        minimum_deployment_target=ct.target.macOS14,
    )
    out_path = out_dir / name
    mlmodel.save(str(out_path))
    return out_path, mlmodel


def assert_spec(mlpackage: Path) -> dict:
    """Read the generated spec and assert the Stage A I/O contract."""
    import coremltools as ct

    model = ct.models.MLModel(str(mlpackage), compute_units=ct.ComputeUnit.CPU_ONLY)
    spec = model.get_spec()
    # description input/output feature names
    in_names = [f.name for f in spec.description.input]
    out_names = [f.name for f in spec.description.output]
    if in_names != [INPUT_NAME]:
        raise AssertionError(f"input names {in_names} != ['{INPUT_NAME}']")
    if out_names != [OUTPUT_NAME]:
        raise AssertionError(f"output names {out_names} != ['{OUTPUT_NAME}']")

    def feature_info(f):
        from coremltools.proto import FeatureTypes_pb2

        t = f.type
        if t.HasField("multiArrayType"):
            arr = t.multiArrayType
            type_name = FeatureTypes_pb2.ArrayFeatureType.ArrayDataType.Name(
                arr.dataType
            )
            return {
                "name": f.name,
                "shape": list(arr.shape),
                "dataType": type_name,
                "rawDataType": int(arr.dataType),
            }
        return {"name": f.name, "kind": "other"}

    inputs = [feature_info(f) for f in spec.description.input]
    outputs = [feature_info(f) for f in spec.description.output]

    # f32 boundary: MultiArray FLOAT32. coremltools proto enum value.
    from coremltools.proto import FeatureTypes_pb2

    FLOAT32 = FeatureTypes_pb2.ArrayFeatureType.FLOAT32
    for info, expected_shape in (
        (inputs[0], list(INPUT_SHAPE)),
        (outputs[0], [1, OUTPUT_DIM]),
    ):
        if info["rawDataType"] != FLOAT32:
            raise AssertionError(
                f"{info['name']} dtype {info['rawDataType']} is not FLOAT32"
            )
        if info["shape"] != expected_shape:
            raise AssertionError(
                f"{info['name']} shape {info['shape']} != {expected_shape}"
            )

    # Spec must describe an ML Program with fp16 internals when requested.
    is_mlprogram = spec.WhichOneof("Type") == "mlProgram" or spec.HasField("mlProgram")
    # Some coremltools versions nest it differently; also check serialized type.
    type_name = spec.WhichOneof("Type")
    return {
        "inputs": inputs,
        "outputs": outputs,
        "typeOneof": type_name,
        "isMLProgram": bool(type_name == "mlProgram" or is_mlprogram),
    }


def python_smoke(traced, n: int = 3) -> dict:
    import torch

    results = []
    with torch.no_grad():
        for i in range(n):
            x = torch.linspace(-1, 1, steps=3 * 224 * 224).reshape(INPUT_SHAPE)
            if i == 1:
                x = torch.rand(INPUT_SHAPE) * 2 - 1
            y = traced(x)
            y_np = y.detach().cpu().numpy()
            results.append(
                {
                    "finite": bool(torch.isfinite(y).all().item()),
                    "shape": list(y_np.shape),
                    "min": float(y_np.min()),
                    "max": float(y_np.max()),
                    "checksum": float(y_np.astype("float64").sum()),
                }
            )
    return {"samples": results, "allFinite": all(r["finite"] for r in results)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out", help="output directory")
    ap.add_argument(
        "--diagnostic-fp32",
        action="store_true",
        help="also build a full-FLOAT32 diagnostic package (parity only; no ANE)",
    )
    args = ap.parse_args()

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Keep HF downloads inside the spike out/ tree so the venv is pure.
    hf_home = out_dir / "hf-cache"
    hf_home.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(hf_home)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_home / "hub"))

    started = time.time()
    print(f"[export] loading {HF_REPO} @ {PINNED_REVISION} …")
    model, load_note, source_files, snap = load_vision(hf_home)
    print(f"[export] loaded via {load_note}; {len(source_files)} source files hashed")

    wrapped = PoolerOnly(model)
    example = torch.zeros(INPUT_SHAPE, dtype=torch.float32)
    print("[export] tracing pooler-only wrapper …")
    with torch.no_grad():
        traced = torch.jit.trace(wrapped, example)
        traced.eval()

    smoke = python_smoke(traced)
    if not smoke["allFinite"]:
        print("[export] FAIL: Python smoke produced non-finite outputs", file=sys.stderr)
        return 2

    print("[export] converting ML Program (FLOAT16 internal, f32 I/O) …")
    import coremltools as ct

    fp16_path, fp16_model = convert_traced(
        traced, out_dir, MLPACKAGE_NAME, ct.precision.FLOAT16
    )
    spec_info = assert_spec(fp16_path)
    print(f"[export] wrote {fp16_path}")
    print(f"[export] spec: {spec_info}")

    fp32_path = None
    fp32_spec = None
    if args.diagnostic_fp32:
        print("[export] converting FLOAT32 diagnostic (NOT an ANE ship candidate) …")
        fp32_path, _ = convert_traced(
            traced, out_dir, MLPACKAGE_FP32_NAME, ct.precision.FLOAT32
        )
        fp32_spec = assert_spec(fp32_path)
        print(f"[export] wrote {fp32_path}")

    versions = tool_versions()
    manifest = {
        "schema": "coreml-native-export/v1",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "registryId": REGISTRY_ID,
        "hfRepo": HF_REPO,
        "pinnedRevision": PINNED_REVISION,
        "loadModelNote": load_note,
        "snapshotPath": str(snap) if snap else None,
        "sourceFiles": source_files,
        "io": {
            "input": {"name": INPUT_NAME, "shape": list(INPUT_SHAPE), "dtype": "float32"},
            "output": {"name": OUTPUT_NAME, "shape": [1, OUTPUT_DIM], "dtype": "float32"},
        },
        "conversion": {
            "convertTo": "mlprogram",
            "computePrecision": "FLOAT16",
            "minimumDeploymentTarget": "macOS14",
            "wrapper": "PoolerOnly → outputs.pooler_output",
        },
        "spec": spec_info,
        "pythonSmoke": smoke,
        "toolVersions": versions,
        "scmGitCommit": git_commit(Path(__file__).resolve().parents[2]),
        "package": {
            "path": str(fp16_path.relative_to(out_dir)) if fp16_path.is_relative_to(out_dir) else str(fp16_path),
            "sha256": package_sha256(fp16_path),
            "bytes": sum(p.stat().st_size for p in fp16_path.rglob("*") if p.is_file()),
        },
        "diagnosticFp32": None,
    }
    if fp32_path is not None:
        manifest["diagnosticFp32"] = {
            "path": fp32_path.name,
            "sha256": package_sha256(fp32_path),
            "bytes": sum(p.stat().st_size for p in fp32_path.rglob("*") if p.is_file()),
            "note": "parity diagnostic only; full fp32 ML Programs cannot run on ANE",
            "spec": fp32_spec,
        }

    man_path = out_dir / "export-manifest.json"
    man_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[export] manifest → {man_path}")
    print(f"[export] done in {time.time() - started:.1f}s")

    # Stage A acceptance checklist (printed for the operator).
    ok = (
        manifest["package"]["sha256"]
        and spec_info["inputs"][0]["name"] == INPUT_NAME
        and spec_info["outputs"][0]["name"] == OUTPUT_NAME
        and smoke["allFinite"]
        and len(source_files) > 0
    )
    print(f"[export] Stage A acceptance: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
