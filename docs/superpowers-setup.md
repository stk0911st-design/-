# Superpowers プラグイン導入メモ

このリポジトリでは Claude Code のプラグイン **Superpowers** を有効化しています。

## Superpowers とは

Claude に「開発の進め方」を教えるスキル集です。公式マーケットプレイス
(`claude-plugins-official`) 配信、提供元は [obra/superpowers](https://github.com/obra/superpowers)。

含まれるスキル（14個）:

| スキル | 内容 |
| --- | --- |
| `brainstorming` | 要件を対話で掘り下げて設計に落とす |
| `writing-plans` / `executing-plans` | 実装計画の作成と実行 |
| `subagent-driven-development` | サブエージェントに作業を分担させる |
| `dispatching-parallel-agents` | 並列エージェントの振り分け |
| `test-driven-development` | red/green の TDD サイクル |
| `systematic-debugging` | 手当たり次第でない原因特定の手順 |
| `requesting-code-review` / `receiving-code-review` | コードレビューの依頼と反映 |
| `verification-before-completion` | 「完了」と言う前の検証 |
| `using-git-worktrees` | git worktree を使った作業分離 |
| `finishing-a-development-branch` | ブランチの締め方 |
| `writing-skills` | 新しいスキル自体の作成 |
| `using-superpowers` | 上記スキル群の使い分け |

常時のコンテキスト消費は約 690 トークン。各スキルの本体は呼び出したときだけ読み込まれます。

## 設定ファイル

`.claude/settings.json`（リポジトリにコミット済み・プロジェクトスコープ）:

```json
{
  "extraKnownMarketplaces": {
    "claude-plugins-official": {
      "source": { "source": "github", "repo": "anthropics/claude-plugins-official" }
    }
  },
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true
  }
}
```

- `extraKnownMarketplaces`: 公式マーケットプレイスの登録。
  通常は Claude Code が起動時に自動登録しますが、クラウドセッションでは
  自動登録されないことがあるため明示しています。
- `enabledPlugins`: このリポジトリで Superpowers を有効にする指定。

## 使う側で必要な操作

Superpowers は外部リポジトリ配信のプラグインのため、
`enabledPlugins` の記載だけでは実体がダウンロードされません。
各自の環境で一度だけ次を実行してください。

```bash
claude plugin install superpowers@claude-plugins-official
```

Claude Code のセッション中なら、スラッシュコマンドでも同じことができます。

```
/plugin install superpowers@claude-plugins-official
```

インストール後、`Run /reload-plugins to activate.` と表示された場合は
`/reload-plugins` を実行すると、そのセッションから使えるようになります。

確認方法:

```bash
claude plugin list                # 一覧に superpowers が出ること
claude plugin details superpowers # 中身とトークンコストの確認
```

## 無効にしたいとき

```bash
claude plugin disable superpowers@claude-plugins-official   # 一時的に止める
claude plugin uninstall superpowers@claude-plugins-official # 完全に外す
```

リポジトリ全体から外す場合は `.claude/settings.json` の
`enabledPlugins` から該当行を削除してください。
