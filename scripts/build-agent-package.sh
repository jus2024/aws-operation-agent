#!/usr/bin/env bash
#
# AgentCore Runtime の direct code deployment（CodeZip）用パッケージを組み立てる。
#
# CDK の `s3_assets.Asset` はディレクトリを zip して S3 にアップロードするだけで、
# 依存関係のインストールは行わない。AgentCore Runtime は Linux arm64 で動くため、
# Linux arm64 向けの wheel を展開したディレクトリを事前に作る必要がある。
#
# ポイント:
# - `--platform` + `--only-binary=:all:` により、macOS / x86 のマシン上でも
#   Linux arm64 向けの wheel だけをダウンロードして展開する（クロスビルド）。
#   ソースビルドは一切行わないため Docker も不要。
# - `--only-binary=:all:` を付けているので、arm64 の wheel が存在しない依存が
#   あればこのスクリプトはエラーで止まる（黙って x86 のバイナリが混ざることはない）。
# - direct code deployment のパッケージ上限は 250MB。超える場合は依存を削るか、
#   Container ビルドに戻す判断が必要。
#
# 使い方:
#   ./scripts/build-agent-package.sh
#
set -euo pipefail

AGENT_DIR="agents/app/AWS_MCP_Agent"
BUILD_DIR="${AGENT_DIR}/.build"
PYTHON_VERSION="3.13"
MAX_SIZE_MB=250

if [[ ! -d "${AGENT_DIR}" ]]; then
  echo "エラー: ${AGENT_DIR} が見つかりません。リポジトリルートから実行してください。" >&2
  exit 1
fi

PY="${PYTHON:-python3}"
if ! command -v "${PY}" >/dev/null 2>&1; then
  echo "エラー: python3 が見つかりません。" >&2
  exit 1
fi

echo "==> 依存関係を Linux arm64 向けに展開します（Python ${PYTHON_VERSION}）"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# pyproject.toml の [project.dependencies] を requirements 形式で書き出す。
# uv / pip のどちらでも読める形にするため、いったんテキストに落としてから渡す。
REQ_FILE="$(mktemp)"
trap 'rm -f "${REQ_FILE}"' EXIT
"${PY}" - "${AGENT_DIR}/pyproject.toml" > "${REQ_FILE}" <<'PY'
import re
import sys

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 以前
    print("エラー: tomllib が使えません。Python 3.11 以上で実行してください。", file=sys.stderr)
    raise SystemExit(1)

with open(sys.argv[1], "rb") as f:
    data = tomllib.load(f)

for dep in data["project"]["dependencies"]:
    print(re.sub(r"\s+", "", dep))
PY

echo "--- 対象の依存 ---"
cat "${REQ_FILE}"
echo "------------------"

"${PY}" -m pip install \
  --target "${BUILD_DIR}" \
  --requirement "${REQ_FILE}" \
  --platform manylinux2014_aarch64 \
  --platform manylinux_2_17_aarch64 \
  --platform manylinux_2_28_aarch64 \
  --python-version "${PYTHON_VERSION}" \
  --only-binary=:all: \
  --quiet

echo "==> エージェントのソースをコピーします"
# テスト・キャッシュ・ローカル仮想環境・ビルド出力自身は除外する。
/usr/bin/env rsync -a \
  --exclude '.build/' \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude '.ruff_cache/' \
  --exclude '.hypothesis/' \
  --exclude 'test_*.py' \
  --exclude 'uv.lock' \
  --exclude 'Dockerfile' \
  --exclude '.dockerignore' \
  "${AGENT_DIR}/" "${BUILD_DIR}/"

UNPACKED_MB=$(du -sm "${BUILD_DIR}" | cut -f1)
echo
echo "==> 完了: ${BUILD_DIR}"
echo "    展開後サイズ: ${UNPACKED_MB} MB（direct code deployment の上限: ${MAX_SIZE_MB} MB）"

NATIVE_NON_ARM=$(find "${BUILD_DIR}" -name '*.so' ! -name '*aarch64*' ! -name '*abi3.so' | head -5 || true)
if [[ -n "${NATIVE_NON_ARM}" ]]; then
  echo
  echo "警告: aarch64 以外に見えるネイティブ拡張があります:" >&2
  echo "${NATIVE_NON_ARM}" >&2
fi

if (( UNPACKED_MB > MAX_SIZE_MB )); then
  echo
  echo "エラー: パッケージが ${MAX_SIZE_MB} MB を超えています（${UNPACKED_MB} MB）。" >&2
  echo "       依存を削るか、Container ビルドを使ってください。" >&2
  exit 1
fi
