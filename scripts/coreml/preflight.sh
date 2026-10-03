#!/usr/bin/env bash
# Stage 0 preflight (plan §2). Exits non-zero if any required check fails.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="scripts/coreml/out"
mkdir -p "$OUT"

pass=0
fail=0
note() { printf '  %s\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf 'FAIL  %s\n' "$*"; fail=$((fail+1)); }

echo "== Stage 0 preflight =="

# 1. Toolchain
if xcode-select -p >/dev/null 2>&1; then
  ok "xcode-select -p → $(xcode-select -p)"
else
  bad "xcode-select -p"
fi

if swiftc --version >/dev/null 2>&1; then
  ok "swiftc --version → $(swiftc --version 2>&1 | head -1)"
else
  bad "swiftc --version"
fi

if xcrun coremlcompiler --help 2>&1 | grep -q 'mlpackage'; then
  ok "coremlcompiler accepts .mlpackage"
else
  bad "coremlcompiler --help does not mention .mlpackage"
fi

# 2. arm64 + hardware record
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ok "host arch arm64"
else
  bad "host arch $ARCH (need arm64)"
fi

{
  echo "preflightAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "arch: $ARCH"
  echo "macOS: $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "xcode: $(xcode-select -p)"
  echo "swiftc: $(swiftc --version 2>&1 | head -1)"
  echo "chip: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
  echo "memory: $(sysctl -n hw.memsize 2>/dev/null || true)"
  echo "coremlcompiler: $(xcrun --find coremlcompiler 2>/dev/null || true)"
  if command -v powermetrics >/dev/null 2>&1; then
    echo "powermetrics: present (privileged ANE sample optional, never a gate)"
  else
    echo "powermetrics: absent"
  fi
} > "$OUT/host-info.txt"
ok "host-info.txt written"

# 3. Python venv + exact requirements (created by setup-venv.sh)
VENV="$OUT/venv"
if [[ -x "$VENV/bin/python" ]]; then
  if "$VENV/bin/python" -c "import torch, transformers, coremltools, numpy, PIL" 2>/dev/null; then
    ok "venv imports torch/transformers/coremltools/numpy/PIL"
    "$VENV/bin/python" -m pip freeze > "$OUT/pip-freeze.txt" || true
    ok "pip freeze captured"
  else
    bad "venv exists but imports failed (run scripts/coreml/setup-venv.sh)"
  fi
else
  note "venv not created yet — run scripts/coreml/setup-venv.sh before Stage A"
  note "recording as WARN, not FAIL (Stage 0 filesystem still created)"
fi

# 4. Pinned HF source (checked by export-vision.py at conversion time)
note "pinned HF revision checked at export time (75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2)"

# 5. ONNX baseline contract (pixel_values / pooler_output / processor)
if node -e "
const fs=require('fs');
const p=process.env.HOME+'/Library/Application Support/scm/models/onnx-community/siglip2-base-patch16-224-ONNX/preprocessor_config.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
const okc = j.image_processor_type==='SiglipImageProcessor'
  && j.size && j.size.height===224 && j.size.width===224
  && Array.isArray(j.image_mean) && j.image_mean.every(x=>Math.abs(x-0.5)<1e-6)
  && Array.isArray(j.image_std) && j.image_std.every(x=>Math.abs(x-0.5)<1e-6);
if(!okc){console.error('preprocessor mismatch',j); process.exit(1)}
console.log('preprocessor OK', j.image_processor_type, j.size);
" 2>"$OUT/onnx-baseline-stderr.txt"; then
  ok "ONNX preprocessor_config matches SiglipImageProcessor 224 / mean-std 0.5"
else
  bad "ONNX baseline preprocessor check"
fi

if [[ -f "$HOME/Library/Application Support/scm/models/onnx-community/siglip2-base-patch16-224-ONNX/onnx/vision_model_quantized.onnx" ]]; then
  ok "ONNX vision_model_quantized.onnx present (q8 baseline)"
else
  bad "ONNX vision weights missing"
fi

# 6. Fixture manifest
if [[ -f scripts/coreml/fixtures/manifest.json ]]; then
  node -e "
const m=require('./scripts/coreml/fixtures/manifest.json');
console.log('counts', m.counts, 'complete', m.complete);
if(!m.complete) process.exit(2);
" && ok "fixtures/manifest.json complete" || bad "fixtures/manifest.json incomplete"
else
  note "fixtures/manifest.json not built yet — run node scripts/coreml/build-fixtures.js"
fi

# 7. gitignore
if grep -q 'scripts/coreml/out/' .gitignore; then
  ok ".gitignore covers scripts/coreml/out/"
else
  bad ".gitignore missing scripts/coreml/out/"
fi

echo
echo "preflight: $pass passed, $fail failed"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
exit 0
