#!/usr/bin/env bash
#
# AgentCore Runtime の direct code deployment（CodeZip）用パッケージを組み立てる。
#
# CDK の `s3_assets.Asset` はディレクトリを zip して S3 にアップロードするだけで、
# 依存関係のインストールは行わない。AgentCore Runtime は Linux arm64 で動くため、
# Linux arm64 向けの依存を展開したディレクトリを事前に作る必要がある。
#
# なぜ pip ではなく uv を使うか:
# - pip の `--platform` / `--python-version` は「どの wheel を選ぶか」の指定でしか
#   なく、requires-python の判定は実行中のインタープリターのバージョンで行われる
#   （pip 21 系で確認）。ホストが Python 3.9 の環境では、Python 3.12 以上を要求する
#   依存（ag-ui-strands 等）の解決に失敗する。Amplify Hosting のビルドイメージ
#   （AL2023）の `/usr/bin/python3` は 3.9 なので、これは実際に踏む問題。
# - uv の `--python-platform` / `--python-version` は本来のクロス解決を行うため、
#   ホストの Python バージョンに依存しない。uv 自体が単一バイナリなので、
#   ビルド環境に Python が無くても動く。
# - `uv.lock` を使えるのでビルドが再現可能になる（pip + pyproject.toml では
#   毎回最新版に解決されてしまう）。
#
# ほかのポイント:
# - `--only-binary :all:` を指定しているので、arm64 の wheel が存在しない依存が
#   あればこのスクリプトはエラーで止まる（x86 のバイナリが混ざることはない）。
# - direct code deployment のパッケージ上限は 250MB。超える場合は依存を削るか、
#   Container ビルドに戻す判断が必要。
# - AgentCore は zip に .pyc / __pycache__ が含まれていると
#   「Your artifact contains Python cache files that are incompatible with the
#   target runtime」で CREATE_FAILED になるため、最後に除去する。
#
# 使い方:
#   ./scripts/build-agent-package.sh
#
set -euo pipefail

AGENT_DIR="agents/app/AWS_MCP_Agent"
BUILD_DIR="${AGENT_DIR}/.build"
TARGET_PYTHON_VERSION="3.13"
TARGET_PLATFORM="aarch64-unknown-linux-gnu"
MAX_SIZE_MB=250

if [[ ! -d "${AGENT_DIR}" ]]; then
  echo "エラー: ${AGENT_DIR} が見つかりません。リポジトリルートから実行してください。" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "エラー: uv が見つかりません。以下のいずれかでインストールしてください。" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  brew install uv" >&2
  exit 1
fi

echo "==> uv: $(uv --version)"
echo "==> 対象: Python ${TARGET_PYTHON_VERSION} / ${TARGET_PLATFORM}"

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# uv.lock からピン留めされた依存一覧を書き出す（--frozen でロックファイルを
# 更新せずそのまま使う。dev 依存とプロジェクト自身は除く）。
REQ_FILE="$(mktemp)"
trap 'rm -f "${REQ_FILE}"' EXIT

echo "==> uv.lock から依存を書き出します"
(cd "${AGENT_DIR}" && uv export \
  --frozen \
  --no-dev \
  --no-emit-project \
  --no-hashes \
  --quiet \
  -o "${REQ_FILE}")

DEP_COUNT=$(grep -cve '^\s*#' -e '^\s*$' "${REQ_FILE}" || true)
echo "    ${DEP_COUNT} パッケージ"

echo "==> 依存を展開します"
uv pip install \
  --target "${BUILD_DIR}" \
  --python-platform "${TARGET_PLATFORM}" \
  --python-version "${TARGET_PYTHON_VERSION}" \
  --only-binary :all: \
  --quiet \
  -r "${REQ_FILE}"

echo "==> エージェントのソースをコピーします"
# テスト・キャッシュ・ローカル仮想環境・ビルド出力自身は除外する。
rsync -a \
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

# uv は .pyc を生成しないが、wheel 自身が同梱している場合があるため念のため除去する
# （AgentCore はキャッシュファイルを含む zip を拒否する）。
CACHE_DIRS=$(find "${BUILD_DIR}" -type d -name '__pycache__' | wc -l | tr -d ' ')
if [[ "${CACHE_DIRS}" != "0" ]]; then
  echo "==> Python のバイトコードキャッシュを除去します（${CACHE_DIRS} 件）"
  find "${BUILD_DIR}" -type d -name '__pycache__' -prune -exec rm -rf {} +
fi
find "${BUILD_DIR}" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

NATIVE_NON_ARM=$(find "${BUILD_DIR}" \( -name '*.dylib' -o -name '*-darwin.so' \) | head -5 || true)
if [[ -n "${NATIVE_NON_ARM}" ]]; then
  echo "エラー: Linux arm64 以外のネイティブ拡張が混入しています:" >&2
  echo "${NATIVE_NON_ARM}" >&2
  exit 1
fi

UNPACKED_MB=$(du -sm "${BUILD_DIR}" | cut -f1)
echo
echo "==> 完了: ${BUILD_DIR}"
echo "    展開後サイズ: ${UNPACKED_MB} MB（direct code deployment の上限: ${MAX_SIZE_MB} MB）"

if (( UNPACKED_MB > MAX_SIZE_MB )); then
  echo
  echo "エラー: パッケージが ${MAX_SIZE_MB} MB を超えています（${UNPACKED_MB} MB）。" >&2
  echo "       依存を削るか、Container ビルドを使ってください。" >&2
  exit 1
fi
