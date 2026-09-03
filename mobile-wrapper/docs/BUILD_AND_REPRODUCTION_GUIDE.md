# OSFH Chat Wrapper 制作・再現手順書

更新日: 2026-09-03
対象ブランチ: `osfh-mobile-wrapper-prototype`

## 0. 原則

この手順の目的は、別スレッド/別担当AIでも「何を作り、どこまで確認し、どこで詰まっているか」を再現できるようにすること。

作業開始時に仕様書 `mobile-wrapper/docs/SPECIFICATION.md` を読む。

未確認事項を推測でPASSにしない。変更は原則1要因ずつ行う。

## 1. リポジトリ

Repository:
`idaten71x-sudo/os_for_human_bridge`

Branch:
`osfh-mobile-wrapper-prototype`

Android project:
`mobile-wrapper/`

主要ファイル:

- `mobile-wrapper/app/src/main/java/com/osfh/chatwrapper/MainActivity.java`
- `mobile-wrapper/app/src/main/AndroidManifest.xml`
- `mobile-wrapper/app/build.gradle.kts`
- `.github/workflows/mobile-wrapper-apk.yml`
- `mobile-wrapper/docs/SPECIFICATION.md`
- 本手順書

## 2. 基本制作フロー

1. 対象ブランチの現行ファイルを取得する。
2. 現在の `versionCode` / `versionName` を確認する。
3. 修正対象を1つ決める。
4. `MainActivity.java` 等を修正する。
5. `versionCode` を必ず増加させる。
6. `versionName` を更新する。
7. ブランチへcommitする。
8. GitHub Actions `Build OSFH Mobile Wrapper APK` の起動を確認する。
9. workflow jobが `success` になるまで確認する。
10. artifact `osfh-chat-wrapper-apk` を取得する。
11. ZIPを展開し `app-debug.apk` を実機へ渡す。
12. 既存固定署名版へ上書きインストールする。
13. E2E確認を行う。
14. PASS/FAILと症状を仕様書へ反映する。

ビルド成功だけで機能成功とは判定しない。

## 3. APK署名の注意

初期試作ではGitHub Actionsの通常debug署名をそのまま利用した結果、別runnerで生成されたAPKが既存インストールへ上書きできない事象が発生した。

現在は試作固定署名を利用する構成。

### 更新時チェック

- applicationIdを不用意に変更しない
- 固定署名を維持
- versionCodeを必ず増やす
- build成功を確認
- 実機上書きインストールを確認

本番公開前には試作署名を廃止し、安全な署名鍵管理へ移行する。

## 4. ベースライン再現

問題切り分け時はv0.2.1相当まで機能を削る。

残すもの:

- WebView
- JavaScript enabled
- DOM storage enabled
- database enabled
- Cookie許可
- third-party Cookie許可
- WebChromeClient
- WebViewClient
- `https://chatgpt.com/` のロード

外すもの:

- DOM injection
- MutationObserver
- JavascriptInterface
- メッセージログ保存
- 固定ヘッダー
- 時刻DOM追加
- WebViewへのフォーカス強制
- 独自タッチリスナー
- その他ChatGPT DOMを書き換える処理

この状態を「ベースライン」と呼ぶ。

## 5. 現在の回答非表示の再現方法

v0.2.2相当で実施する。

1. アプリ起動。
2. ChatGPTへログイン済みであることを確認。
3. 既存スレッドを開く。
4. 入力欄へ短いメッセージを入力。
5. 送信。
6. ユーザーメッセージが会話上に表示されることを確認。
7. assistant回答が表示されるか待つ。

2026-09-03時点の実機結果:

- userメッセージ: 表示される
- assistant回答: 表示されない事象あり
- UAをブラウザ寄りに戻しても解消しなかった

したがってUA単独原因とは扱わない。

## 6. 次の診断版の制作手順

次版では完成機能を大量に戻さず、診断を優先する。

### 6.1 回答待機UI

送信を検知したら、ChatGPT本体の操作を覆わない位置へ小さな状態表示を出す。

状態例:

- `送信済み・回答待ち`
- assistant DOMを確認したら非表示または `回答受信`
- 規定時間を超えたら `回答を表示できていません`

重要:

- 全画面overlayは禁止
- `pointer-events` 等でChatGPTのタップを阻害しない
- 「待てば必ず回答が来る」という表現は禁止

### 6.2 診断ログ

回答非表示原因を切り分けるため、少なくとも以下の観測を検討する。

- WebView console message
- page load error
- resource/request error
- HTTP error
- renderer process異常
- page URL遷移
- assistant DOM出現有無

診断処理自体がChatGPT DOMを変更しないようにする。

### 6.3 判定

assistant DOMが存在するが見えない:
表示/CSS/描画系を調査。

assistant DOM自体が生成されない:
通信/JS/ストリーム/クライアント互換性側を調査。

WebView側で継続的に成立しない場合:
WebView方式に固執せず、別のChromium系実装または別アーキテクチャを検討する。

## 7. ファイル添付の実装手順

回答表示が安定した後に実施。

1. `WebChromeClient` を拡張。
2. `onShowFileChooser` を実装。
3. Android Activity Result API等でファイル選択を起動。
4. WebViewの `ValueCallback<Uri[]>` へ結果を返す。
5. cancel時もcallbackを解放。
6. 単一画像をテスト。
7. 複数画像をテスト。
8. PDF等の一般ファイルをテスト。
9. ChatGPTへの実送信まで確認。

「選択画面が開いた」だけではPASSにしない。ChatGPT側へ添付され、送信できるところまで確認する。

## 8. ログ取得の再導入手順

回答表示と添付が安定してから実施。

1. DOMを書き換えずメッセージ観測だけ追加。
2. userメッセージ保存確認。
3. assistantメッセージ保存確認。
4. 長いストリーミング回答で重複/欠落確認。
5. スレッド切替確認。
6. 長スレッド確認。
7. 入力・スクロール・各ボタンが壊れていないことを再確認。

保存候補形式:

```json
{"ts":"ISO-8601","role":"user|assistant","text":"...","url":"...","title":"...","app_version":"..."}
```

`ts` がDOM観測時刻なら、その意味を明記する。送信時刻と偽装しない。

## 9. スレッド名表示の再導入

ログ取得PASS後に実施。

優先順位:

1. Webページが持つタイトル/会話識別情報を読む
2. 必要なら専用アプリ側の非干渉UIに表示

ChatGPT DOMへ固定要素を直接挿入する方式は、タップ領域を壊す可能性があるため最後の手段とする。

## 10. タイムスタンプ再導入

真の送信時刻が取得できない場合は、UI上に単に「送信時刻」と表示しない。

代替:

- `観測 20:15:03`
- ログ内だけに保持

ChatGPTの各メッセージDOMへ兄弟要素を大量追加する方式は、レイアウト影響を確認してから採用する。

## 11. 実機E2Eチェックリスト

各APKで最低限以下を順番に確認する。

- [ ] APK上書きインストール成功
- [ ] 起動成功
- [ ] ログイン状態/アカウント確認
- [ ] スレッド一覧表示
- [ ] 既存スレッドを開ける
- [ ] メニューを押せる
- [ ] 入力欄を押せる
- [ ] キーボード表示
- [ ] 日本語入力
- [ ] 送信
- [ ] userメッセージ表示
- [ ] 回答待機状態表示
- [ ] assistant回答表示
- [ ] スクロール
- [ ] 回答下部の操作ボタン
- [ ] スレッド切替
- [ ] 画像添付
- [ ] 複数画像添付
- [ ] ファイル添付
- [ ] ログ保存
- [ ] 再起動

FAILしたら、その版に追加した変更を最初に疑い、複数機能を追加したまま原因調査しない。

## 12. 事故防止ルール

- 「ビルド成功」=「アプリ正常」ではない。
- スクリーンショット上の症状だけで専用アプリ原因と断定しない。公式アプリ/専用アプリのどちらかを確認する。
- WebViewの問題を「同期が遅いだけ」と決めつけない。
- assistant回答が見えない状態を無限ローディングで隠さない。
- 既存の正常機能を一度に大量に戻さない。
- 変更前ファイルを取得し、現行SHA/内容を確認してから更新する。
- workflow failure時はjob logを確認してから修正する。
- APKをユーザーへ渡す前にworkflow successとartifact生成を確認する。

## 13. ここまでの版履歴

### 初期版

WebView + ChatGPT + ログ保存試作。

### UI追加試作

スレッド名固定ヘッダー、メッセージ観測時刻、フォーカス処理を追加。

### v0.2.1

切り分け用ベースライン。DOM監視・ログ・UA変更等を除去。

### v0.2.2

ベースラインへブラウザ寄りUAのみ復帰。送信後のassistant回答非表示は解消せず。

## 14. 次回再開地点

最初にやること:

1. 本仕様書と手順書を確認。
2. v0.2.2のコードを基準にする。
3. 回答待機表示と、非干渉のWebView診断ログを追加した次版を作る。
4. 実機でassistant DOM/通信エラーのどちら側かを切り分ける。
5. 回答表示を解決するまでログ取得・ヘッダー・時刻表示を本格復帰させない。
