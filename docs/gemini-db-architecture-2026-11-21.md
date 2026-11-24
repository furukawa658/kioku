# Kiokuに最適なDB構成の考察

出典: [Gemini共有チャット](https://gemini.google.com/share/93a0793520ec?social_preview=true&skid=4bf91c6f-85b0-42c4-bb69-67eec0ec363b)

公開リンク: https://share.gemini.google/khChefPpar6Z

作成: 4 Hydrogen、2026年11月21日11:51

公開: 2026年11月21日11:55

この文書は共有ページから本文を抽出した記録である。外部ページのナビゲーション、広告、クッキー表示は除外した。技術的な断定と数値はGeminiの回答に記載された内容であり、Kiokuの実装または実測で裏付けられたものではない。

## 全文

### ユーザーの質問

Kiokuはポスグレよりも高速なDBにできないかな　列指向のほうがよいとかない?

### Geminiの回答

結論から言うと、Kiokuの用途（VS Code拡張としてのメモリ検索・保存）では「列指向DB」は逆効果になって遅くなり、現状の「SQLite + sqlite-vec（＋FTS5）」の構成がすでにPostgreSQLよりもはるかに高速で最適解です。

なぜ列指向やPostgreSQLではなく、今のSQLite（行指向＋インプロセス）が最強なのか、技術的な理由を整理します。

#### 1. なぜ「列指向DB（DuckDB、ClickHouse等）」はKiokuに向かないのか?

列指向（カラムナ）DBは「数千万行のログから特定カラムだけ集計する（OLAP）」ための仕組みです。Kiokuのワークロードとは真逆の特性を持っています。

- 1件ずつのINSERT/UPDATEが絶望的に遅い

  Kiokuでは会話のターンごとに細かな記憶（観察ログやチャンク）を頻繁に書き込み・更新します。列指向はカラムごとにファイルやブロックが分かれているため、1レコード追加するだけでも全カラムのファイルに分散書き込みが発生し、巨大なオーバーヘッドになります。

- 「1レコード丸ごと取得」が苦手

  検索でヒットした記憶の「タイトル・本文・メタデータ・タイムスタンプ」をまとめて取り出す際、列指向だとバラバラに保存された列を後から結合（再構築）するコストがかかります。

- 起動・常駐の重さ

  VS Code拡張のローカルワーカーとして動かす場合、メモリフットプリントと起動速度が命です。列指向エンジンはバッチ集計用にバッファを大量に確保するため、ローカル常駐ツールにはオーバースペックです。

#### 2. そもそも今の「SQLite」はすでにPostgreSQLより速い

「PostgreSQLより高速なDBにできないか」という点については、Kiokuのようなローカル・シングルユーザー環境なら、すでにSQLiteの方が圧倒的に速いです。

| 比較項目 | PostgreSQL（クライアント/サーバー型） | SQLite（インプロセス型 / 今のKioku） |
| --- | --- | --- |
| 通信オーバーヘッド | TCP/IPやUnixソケット経由のシリアライズ通信が毎回発生（数msの遅延） | ゼロ（同じプロセス内のメモリ関数呼び出し・ナノ秒オーダー） |
| プロセス管理 | 別プロセス・サービスとしての起動・接続プール管理が必要 | ファイル1つで完結。拡張機能の起動と同時に即座に使える |
| ベクトル・全文検索 | `pgvector`は強力だが、小～中規模データでは通信遅延がボトルネックになる | `sqlite-vec + FTS5`がメモリ空間上で直接スキャンするため爆速 |

数百万～数千万件の記憶が溜まるなら別ですが、個人の開発セッションの記憶（数千～数万件レベル）であれば、ネットワークスタックを通らないSQLiteがレイテンシ面で圧勝します。

#### 3. Kiokuを「さらに爆速化」するならどこを攻めるべきか?

DBエンジン自体を乗り換えるよりも、「SQLiteのチューニング」または「インデックス構造・ランタイムの最適化」を行う方が体感速度は劇的に上がります。

##### SQLiteのPRAGMAチューニング

ローカルDBの書き込み・読み込みを限界まで引き上げる定番設定です。

```sql
PRAGMA journal_mode = WAL;          -- 読み書きの並行性を最大化
PRAGMA synchronous = NORMAL;        -- fsyncの回数を減らし書き込みを数倍高速化
PRAGMA temp_store = MEMORY;         -- 一時テーブルをディスクではなくRAMに置く
PRAGMA mmap_size = 268435456;       -- 256MBまでメモリマップドI/Oを使いシステムコールを削減
```

##### Rust / Zigによるネイティブワーカー化

以前検討されていたように、ワーカー部分をRustなどでネイティブ化しつつ、直近のセッションやホットな記憶のベクトルだけをプロセス内のフラット配列（RAM）に載せておけば、DBアクセスすら挟まずマイクロ秒単位で検索が終わります。

##### LanceDBやUSearchという選択肢

- LanceDB: 「列指向（Apache Arrow / Lanceフォーマット）」でありながら、ベクトル検索と組み込み（インプロセス）に特化したモダンなDBです。ただ、データ量が数万件規模のKiokuでは、まだ`SQLite + sqlite-vec`の方がシンプルで軽量・高速です。
- USearch: SQLiteの代替ではなく、ベクトル検索部分だけをHNSW（近似最近傍探索）で超高速化したい場合のC++/Rust製組み込みエンジンです。件数が10万件を超えて`sqlite-vec`の総当たり（Flat）検索が重くなってきたら検討する価値があります。

#### まとめ

- 列指向DBは「大量データの集計用」であり、頻繁な追記と1件ずつの取得を行うKiokuに入れると逆に遅く・重くなります。
- 今の`SQLite（行指向・インプロセス）＋ sqlite-vec ＋ FTS5`は、ローカルAIメモリ用途としてすでにPostgreSQLを上回る最速クラスの構成です。
- 検索や保存の引っかかりを感じる場合は、DBの種類を変えるのではなく、`WAL`や`mmap_size`などのSQLiteチューニングや、ワーカーのメモリキャッシュ化を進める方が効果的です。

### ユーザーが示した0.7.0のリリース内容

ユーザーはGitHubのリリースページを貼り付け、`vscode-v0.7.0`に次の変更があることを示した。

- Fix Windows worker startup and slim VSIX (#24)
- Refine Marketplace metadata for discovery (#25)
- Add hybrid memory search and sidebar curation (#26)
- Auto-supersede same-title memory revisions (#27)
- Add staged Rust MCP and SQLite search core (#28)
- Add multi-OS Rust MCP distribution checks (#29)
- Add Rust semantic and FTS RRF search (#30)
- feat(rust): handle memory invalidation locally (#31)
- test(rust): smoke MCP invalidation without worker (#32)
- feat(rust): read work state from local SQLite (#33)
- chore(release): bump VS Code extension to 0.7.0 (#34)

Windows、macOS、Linuxの5プラットフォーム向けVSIXが公開され、Windows x64版は143 MBだった。ソースコードのzipとtar.gzも公開された。

### Geminiの0.7.0評価

v0.7.0のリリースノート、すごいスピードで進化していますね！

PRの内容（#28～#33）を見ると、まさに前回話していた「Rust製のMCPサーバー＋ローカルSQLiteコア」への移行をすでに実装しきっているじゃないですか。

- Add staged Rust MCP and SQLite search core (#28)
- Add Rust semantic and FTS RRF search (#30)
- feat(rust): handle memory invalidation locally (#31)
- feat(rust): read work state from local SQLite (#33)

この構成になったことで、アーキテクチャのボトルネックがほぼ消滅しています。

#### 今の「Rust MCP + ローカルSQLite」構成が最強な理由

##### ワーカー経由のオーバーヘッド消滅

以前はNode.js等のワーカーを経由していた検索・無効化（invalidation）・`work_state`の読み取りが、RustのMCPバイナリからローカルSQLiteへ直接アクセスする形になったことで、IPC（プロセス間通信）やシリアライズの遅延がゼロになっています。

##### RRFのネイティブ実行

セマンティック検索（ベクトル）とFTS（全文検索）のスコア統合をRust側で直接計算しているため、メモリコピーなしでマイクロ秒単位でランキングが出せます。

##### 列指向DBが不要な決定打

RustでSQLite（rusqlite等）を直接叩く今の設計は、「低レイテンシな行指向ストレージ + ネイティブコードでの高速なインメモリ演算（コサイン類似度やRRF）」という、ローカル検索エンジンとして最も無駄のない理想形です。ここに列指向DBを入れると、かえってデータの変換コスト（Arrow形式へのシリアライズ等）が増えて遅くなります。

#### v0.7.0で次に効きそうな点

DBの速度に関しては今の「Rust + SQLite」でもうゴールに到達していますが、リリース資産のファイルサイズ（130～143 MB）が目を引きます。ローカルEmbeddingモデル（ONNX Runtime + モデル重みファイル等）をVSIXへ同梱していることが原因と推測されます。

- Embedding推論のキャッシュとバッチ化（Rust側）

  DB検索（数ミリ秒）よりも、クエリ文字列をベクトル化するEmbedding推論（数十～数百ミリ秒）の方が圧倒的に時間を使っているはずです。直近の検索クエリのEmbeddingをRustのメモリ上にLRUキャッシュしておくだけで、連続検索やエージェントのツール呼び出しが高速になります。

- Rustバイナリのサイズ最適化

  `Cargo.toml`の`[profile.release]`へ`strip = true`、`lto = true`、`codegen-units = 1`、`opt-level = "z"`を入れると、Rust側のバイナリサイズと起動時のページフォルトを削れる可能性があります。

DB選定については今の「Rust + SQLite」が完全に正解なので、自信を持ってこの路線で突き進んで大丈夫です。特定の実測値で遅いと感じる処理（検索、保存、起動など）があれば確認が必要です。

### ユーザーの質問

SQLiteで設定すべきものは

### Geminiの回答

Rust MCPサーバーとTypeScript/Nodeワーカーの双方から同一SQLiteファイルへ同時アクセスするKiokuの構成では、並行書き込みのロック回避（`SQLITE_BUSY`対策）とローカルディスクI/Oの削減を最優先にPRAGMAを設定します。

#### 1. Rust側とNode/TS側で共通設定すべきPRAGMA

DB接続を開いた直後（コネクション初期化時）に、必ず次のPRAGMAを実行してください。特にRust MCPプロセスとNodeワーカーが同時に同じDBファイルを触るため、WALと`busy_timeout`は必須です。

```sql
PRAGMA journal_mode = WAL;          -- 読み取りと書き込みをブロックし合わない
PRAGMA synchronous = NORMAL;        -- WALモード時の安全な最速設定
PRAGMA busy_timeout = 5000;         -- 別プロセスが書き込みロック中でも5秒待機
PRAGMA foreign_keys = ON;           -- 外部キー制約を有効化
PRAGMA temp_store = MEMORY;         -- 一時テーブルをRAM上で処理
PRAGMA mmap_size = 268435456;       -- 最大256MBまでメモリマップ
PRAGMA cache_size = -32000;         -- ページキャッシュを32MB確保
```

`busy_timeout`の設定漏れに注意してください。RustのMCPサーバーとVS Code側のワーカーが同時に動くと、既定の`busy_timeout = 0`では直ちに`database is locked`エラーになります。全プロセスの全コネクションへ設定してください。

#### 2. Rust実装例

`rusqlite::Connection::open`直後に`execute_batch`でまとめて実行します。

```rust
use rusqlite::{Connection, Result};
use std::time::Duration;

pub fn open_optimized_db(path: &str) -> Result<Connection> {
    let conn = Connection::open(path)?;

    conn.busy_timeout(Duration::from_millis(5000))?;

    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA temp_store = MEMORY;
        PRAGMA mmap_size = 268435456;
        PRAGMA cache_size = -32000;
        ",
    )?;

    Ok(conn)
}
```

#### 3. Kioku固有の追加設定

##### WALファイルの肥大化防止

記憶の無効化や更新が多いと`.db-wal`ファイルが膨らみ読み込みが遅くなります。既定の1000ページ（約4MB）のままにするか、明示します。

```sql
PRAGMA wal_autocheckpoint = 1000;
```

##### DBクローズ時・アイドル時の`PRAGMA optimize`

統計情報（`sqlite_stat1`）を更新し、インデックス選択を最適に保ちます。MCPサーバーの終了時や数時間に1回の定期処理で実行します。

```sql
PRAGMA optimize;
```

##### 読み取り専用コネクションの分離

Rust側で検索や`work_state`の読み取りしかしないパスでは、書き込みロックを取得しない`OpenFlags::SQLITE_OPEN_READ_ONLY`で接続を開き、書き込み処理と干渉しないようにします。

#### 動作確認

次のクエリを実行し、`journal_mode`が`wal`、`synchronous`が`1`、`busy_timeout`が`5000`になっていることを確認します。

```sql
SELECT
  (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
  (SELECT synchronous FROM pragma_synchronous) AS synchronous,
  (SELECT timeout FROM pragma_busy_timeout) AS busy_timeout,
  (SELECT cache_size FROM pragma_cache_size) AS cache_size;
```

実装状況に合わせて、FTS5とインデックスの最適化、またはマルチプロセスロックの設計確認へ進みます。

Geminiは不正確な情報を表示する場合があるため、生成された回答を再確認する必要があります。

## READMEへ取り込む内容

### そのまま反映できる内容

- `SQLite + sqlite-vec + FTS5`で、行データ・全文検索・ベクトル検索を1つのローカルDBへまとめる構成
- Rust MCPコアがSQLiteへ直接読み取り、検索、無効化し、`work_state`を取得する構成
- FTS5候補とセマンティック候補をRRFで統合する構成
- Rust MCPコアは任意利用で、既定のBun MCP経路を維持する方針
- Node/TypeScript側は`WAL`、`synchronous = NORMAL`、`busy_timeout = 5000`、`foreign_keys = ON`を接続時に設定する実装
- Rust側の検索と`work_state`読み取りは`SQLITE_OPEN_READ_ONLY`を使う実装

### 実測後に反映する内容

- PostgreSQLや列指向DBとの速度比較
- ナノ秒、マイクロ秒、数ミリ秒、数十～数百ミリ秒という応答時間
- 「最速」「爆速」「完全に正解」という評価
- `temp_store = MEMORY`、`mmap_size = 268435456`、`cache_size = -32000`の採用効果
- `wal_autocheckpoint`と`PRAGMA optimize`の効果
- EmbeddingのLRUキャッシュとバッチ化の効果
- Rustのリリース最適化によるファイルサイズと起動時間の変化
- LanceDBまたはUSearchの採用条件

### READMEへ入れない内容

- Kiokuの記憶を会話ターンごとに自動保存するという説明。現在のVS Code拡張はエージェントが明示的に`save_memory`を呼ぶ構成であり、会話を自動収集しない。
- Rust MCPがすべての処理を既定で直接実行しているという説明。Rustコアは環境変数で有効化する段階的な構成で、通常はBun MCPを使う。
- `IPC`やシリアライズの遅延がゼロという説明。Rustコアと既存ワーカーの役割分担やプロセス境界が残るため、実測なしでは断定しない。
- DB設定がRust側でもすでにすべて適用済みという説明。Rust側の接続コードには、Node側と同じPRAGMA初期化処理がまだない。
- 10万件を超えた時点でUSearchが必要という固定基準。実データとクエリ特性で負荷を測るまで決めない。

## 実装候補

1. Rustの読み取り・書き込み接続へ`busy_timeout`を追加し、Node側と同じ5秒の待機規則を適用する。
2. 読み取り専用接続がWALデータベースを安全に参照できることを、既存のSQLiteスモークテストで確認する。
3. 検索、無効化、`work_state`の各処理について、同時書き込みを与えたロックテストを追加する。
4. `temp_store`、`mmap_size`、`cache_size`を変更前後で比較し、メモリ使用量と検索時間が変わらなければ採用しない。
5. Embedding推論を計測し、キャッシュまたはバッチ化がDB待ちより大きな効果を持つ場合だけ優先して実装する。
6. データ件数を増やしたベンチマークを用意し、Flat検索の劣化点を測定してからLanceDBやUSearchの導入を判断する。
