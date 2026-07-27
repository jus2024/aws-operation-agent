---
inclusion: fileMatch
fileMatchPattern: "amplify/**/*"
---

# Amplify バックエンド方針

- `amplify/` をバックエンド定義のソースとして扱う
- バックエンド定義は TypeScript ファーストで、レビューしやすく保つ
- 大規模な書き換えより、段階的なバックエンド変更を優先する
- バックエンド定義を変更する際は、フロントエンドへの影響を説明する
- Amplify sandbox による反復開発と相性の良いパターンを優先する

# AgentCore Runtime との関係

AgentCore Runtime / Memory は **Amplify バックエンドスタックの一部**として定義する
（`amplify/agent/resource.ts`）。AgentCore CLI は使用しない。

- `AGENT_ENABLED=true` のときのみ AgentCore のリソースを作成する。未設定時に生成される
  テンプレートは、エージェント無しの構成と完全に同一でなければならない
- Runtime へは direct code deployment（CodeZip）で配布する。Docker を必要としないため、
  Amplify のビルド環境が Docker 非対応という制約に当たらない
  （CDK の Docker bundling オプションは使わない。依存の展開は
  `scripts/build-agent-package.sh` の責務）
- 同一スタックに載せる利点を活かし、テーブル名・ARN・Memory ID は synth 時に解決する。
  プレースホルダや手動の環境変数設定を新たに増やさない
- AgentCore Memory は会話履歴を保持するため `RemovalPolicy.RETAIN` を維持する
- リソース名は Amplify のバックエンド識別子から作る。**名前を変えるとリソースが置き換わり、
  Memory の置き換えは会話履歴の断絶を意味する**
- Cognito User Pool は Amplify が管理し、中継 Lambda の JWT 署名検証で参照する
