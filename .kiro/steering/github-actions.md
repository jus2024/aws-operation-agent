---
inclusion: fileMatch
fileMatchPattern: ".github/workflows/**/*"
---

# GitHub Actions 方針

- ワークフローは最小限で読みやすく保つ
- 検証を優先する: lint、型チェック、テスト
- ワークフローファイルにシークレットを埋め込まない
- Web アプリのチェックとオプションのエージェントチェックを分かりやすく保つ
- エージェントチェックがオプションの場合、エージェント不使用プロジェクトの負担にならない構造にする

# エージェント CI の追加

> **このリポジトリでの判断**: `ci-agents.yml` は**意図的に追加していない**。エージェント側の
> 検証は `agents/app/AWS_MCP_Agent/` でのローカル実行（`pytest` / `uvx ruff check .`）で行う。
> 以下はテンプレートを別プロジェクトで再利用する場合の指針。

`agents/` ディレクトリが追加された場合（`agentcore create` で生成後）、エージェント用の CI ワークフローを追加する:

- ファイル: `.github/workflows/ci-agents.yml`
- トリガー: `agents/**` のパス変更時
- 内容: Python lint（ruff）+ インポート確認
- Python バージョン: 3.13
- working-directory: `agents/app/<agent_name>/`

テンプレート:
```yaml
name: CI - Agents
on:
  push:
    branches: [main, develop]
    paths: ["agents/**"]
  pull_request:
    branches: [main, develop]
    paths: ["agents/**"]
jobs:
  smoke-check:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: agents/app/<agent_name>
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install -e .
      - run: ruff check .
```
