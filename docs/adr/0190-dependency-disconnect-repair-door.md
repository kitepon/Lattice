# ADR 0190: binding_staleなstoreでもdependency disconnectだけは通す（修理扉）

- status: accepted
- date: 2026-08-29

## 文脈

越境依存は接続時に相手planのtopology_digestへ固定束縛され、相手planがその後revise等で
構造を変えるとbinding_staleになる。storeの読込はfail closedで全コマンドが失敗するが、
ADR 0053が要求する修理（再bind）を行うコマンド自身もstore読込を要するため、
**修理経路が存在しない**（実被弾 2026-08-29: evidence-2の改訂でpolyのstore全体が
読めなくなり、disconnectも同じbinding_staleで詰んだ。円卓の全席が工程正本を失った）。

## 決定

`dependency disconnect`だけは、digest不一致（binding_stale）を許容してstoreを読み、
tombstoneを積める（修理扉）。

- 許容するのはstaleだけ。dangling／cross_plan_binding_missingは修理扉でもfailする
- 書込み側（appendTodoEvent）の許容も`cross_plan_dependency_removed`のkindに限る
- 他の全コマンドは従来どおりbinding_staleでfail closedする

復旧手順: `dependency disconnect`で陳腐化した線を除去 → 必要なら`dependency connect`で
現digestへ張り直す。

## 帰結

- v0.67.4で出荷。実storeで端到端実測済み（status失敗→扉経由disconnect成功→
  connect張り直し→status復活）
- 合成の再現fixture（revise一式）は費用対効果で見送り。実被弾storeでの実測を検証の正とした

## 2026-11-07 amendment: preserve existing completed-target connections

A committed successor can leave existing journal-backed source bindings stale.
Disconnect/reconnect cannot preserve a completed target because new connect
correctly refuses that target. The Store-only identity-preserving rebind API
therefore uses a private stale-digest-only read under lock, exact manifest/chain
CAS and a mandatory Plan carry validator. It stages paired removal/replacement
events preserving both endpoints and publishes one owner chain atomically only
after strict full-graph validation. Ordinary reads/writers retain strict binding
checks. See the canonical [Store recovery contract](../architecture/dfd-store-phase-revision.md).
