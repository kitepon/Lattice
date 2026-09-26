# ADR 0192: 複数の証拠不達を順に再束縛する

- Status: accepted
- Date: 2026-09-26
- Supersedes: ADR 0183 Decision 4 の「他taskの不達も拒否する」制限

## Context

fresh cloneで複数taskの旧evidence blobがGitから到達不能な場合、
`evidence promote`は対象以外の不達で書込み前に停止する。
対象を変えても別taskで停止し、通常のtask遷移まで止まる。
消失した過去の証拠を永続的な書込み前提にすると、作業を再開できない。

## Decision

1. 既存eventの証拠やimport sourceが不達でも、taskには`evidence_unverified`を残し、
   通常の書込みと`evidence promote`を進める。別taskの不達を修復済みとは扱わない。
2. 新eventが追加する証拠は書込み前にhard検証する。不正ならeventを記録しない。
3. `todo verify`は未検証のtaskを報告して失敗する。作業の書込みは止めない。
4. revisionでcarryする旧証拠は未検証のまま保持する。journal、done状態、完了日時、
   imported値の契約はADR 0183どおり維持する。

## Acceptance

- 2 taskの旧証拠を失わせ、1件目のpromoteと別taskの通常遷移が成立しても
  verifyは未修復taskを報告する。
- 2件目をpromoteした後にverifyが通る。
- 不正な新evidenceは書込み前に拒否する。
