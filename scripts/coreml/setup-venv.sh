#!/usr/bin/env bash
# Create the isolated conversion venv under scripts/coreml/out/venv with
# the exact pins in requirements.txt (plan §2.3).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/scripts/coreml"
VENV=out/venv
PY="${MIMO_PYTHON:-python3}"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[setup-venv] creating $VENV with $PY"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --upgrade pip wheel setuptools
"$VENV/bin/python" -m pip install -r requirements.txt
"$VENV/bin/python" -m pip freeze > out/pip-freeze.txt
echo "[setup-venv] ready:"
"$VENV/bin/python" -c "import torch,transformers,coremltools,numpy,PIL; print('torch',torch.__version__,'transformers',transformers.__version__,'coremltools',coremltools.__version__,'numpy',numpy.__version__,'PIL',PIL.__version__)"
