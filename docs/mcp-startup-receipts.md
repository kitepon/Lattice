# MCP startup receipts

通常の `lattice-mcp` wrapper は、起動経路ごとに私有の `~/.lattice/mcp-startup/slot-N/receipt.json` を best-effort で残す。sensor を単独で呼ぶ既存 API や daemon 内部の接続を、wrapper の起動として重ねて記録しない。

記録は run UUID、PID と OS で観測できた process birth（得られなければ null）、wrapper 版、sensor 版、実際の direct / proxy 経路、次の固定段階と時刻だけである。wrapper と sensor の版は別の値になり得る。

- `started`: wrapper が実際の経路へ入った。
- `initialize_received`: initialize request を処理する境界へ届いた。
- `initialize_response_written`: その応答の `stream.write` callback が error 無しで完了した。

write 完了は client の受信・tool の成功・終了の証明ではない。exit / signal は保証しない。短命な起動は worker の保存より先に終わり、全部または一部が未記録になり得る。欠測を成功や失敗へ補完しない。request / response 本文、clientInfo、path、引数、秘密、stack は記録しない。runtime error の件数へ成功を加算しない。

保存は本体から切り離した unref worker で行い、同期の Windows ACL 検査や process birth の取得を initialize が待たない。POSIX は本人所有の directory 0700 / file 0600、Windows は既存の本人・SYSTEM・Administrators 限定 DACL 検査を使う。symlink / junction や確認できない権限の置き場へは保存しない。記録の I/O・権限・worker 生成が失敗しても、記録を省略して MCP の起動と応答を続ける。

上限は累積 64 slot、各 JSON は最大 4 KiB。slot は排他 mkdir で予約し、各 slot の `pending.json` から `receipt.json` へ atomic rename する。一時 JSON は各 slot で最大 1 本、Windows ACL 検査の一時 file は検査後に消す。失敗した予約 slot は消さず、上限に数える。満杯では新しい記録を省略し、古い記録や active か不明な記録を自動削除しない。継続して観測するには、利用者が必要な記録を保全し、MCP が停止した状態で slot を整理する必要がある。既存の未知 file を勝手に回収しない。
