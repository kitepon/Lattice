// roundtable-exec-20260809 の witness set v5 を生成する。
// boundary compilerは一度に8 ToDoまで（schedulability-compiler-v2のMAX_TODOS）なので、
// witnessは着手する波のsubsetだけを書き出してcompileする。
// usage: node scripts/gen-roundtable-witness.mjs [taskId...]（省略時はWave 1: t1..t7）
import { writeFileSync } from 'node:fs'
import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs'
import { explainTodoWitnessSet } from '../src/todo-independence-contracts.mjs'

const p = t => ({ kind: 'path', target: t })
const pc = t => ({ kind: 'path', target: t, creates: true })
const se = (r, k) => ({ resource_id: r, kind: k })
const unk = (k, r) => ({ kind: k, ref: r })
const EV = id => `evidence/roundtable-exec-20260809/${id}.md`

// 既定の空欄
const base = () => ({
  owns: [], reads: [], writes: [], resources: [], state_effects: [],
  sensor_provenance: { queries: [] }, affected_tests: [], unknowns: [],
})

const W = {}
const def = (id, over) => { W[id] = { ...base(), ...over } }

// ---- Lattice側 ----
def('t1', {
  owns: [
    pc('bin/lattice-work-order-adapter.mjs'), p('package-lock.json'), p('package.json'),
    p('src/runtime-cli.mjs'), p('src/runtime-controller-protocol.mjs'),
    p('src/runtime-direct-os-observer.mjs'),
    pc('src/runtime-work-order-contracts.mjs'), pc('src/runtime-work-order-controller.mjs'),
    p('test/runtime-controller-protocol.test.mjs'), p('test/runtime-direct-os-observer.test.mjs'),
    pc('test/runtime-work-order-contracts.test.mjs'), pc('test/runtime-work-order-controller.test.mjs'),
    pc(EV('t1')),
  ],
  reads: ['src/runtime-adapter-registry.mjs', 'src/runtime-diff-observer.mjs', 'src/runtime-scripted-adapter-controller.mjs', 'src/runtime-scripted-worktree.mjs'],
  writes: [
    'bin/lattice-work-order-adapter.mjs', 'package-lock.json', 'package.json',
    'src/runtime-cli.mjs', 'src/runtime-controller-protocol.mjs',
    'src/runtime-direct-os-observer.mjs',
    'src/runtime-work-order-contracts.mjs', 'src/runtime-work-order-controller.mjs',
    'test/runtime-controller-protocol.test.mjs', 'test/runtime-direct-os-observer.test.mjs',
    'test/runtime-work-order-contracts.test.mjs', 'test/runtime-work-order-controller.test.mjs', EV('t1'),
  ],
  affected_tests: [
    'test/runtime-controller-protocol.test.mjs', 'test/runtime-direct-os-observer.test.mjs',
    'test/runtime-work-order-contracts.test.mjs', 'test/runtime-work-order-controller.test.mjs',
  ],
})
def('t2', {
  owns: [
    p('src/runtime-cli.mjs'), p('src/runtime-managed-supervisor.mjs'),
    p('test/runtime-managed-supervisor.test.mjs'), pc(EV('t2')),
  ],
  reads: ['src/runtime-engine.mjs'],
  writes: [
    'src/runtime-cli.mjs', 'src/runtime-managed-supervisor.mjs',
    'test/runtime-managed-supervisor.test.mjs', EV('t2'),
  ],
  affected_tests: ['test/runtime-managed-supervisor.test.mjs'],
})
def('t3', {
  owns: [p('src/runtime-cli.mjs'), pc(EV('t3'))],
  reads: ['src/todo-independence-contracts.mjs'],
  writes: ['src/runtime-cli.mjs', EV('t3')],
})
def('t10', {
  owns: [pc(EV('t10'))],
  reads: ['src/runtime-cli.mjs', 'src/runtime-engine.mjs'],
  writes: [EV('t10')],
  unknowns: [unk('pending_decision', 'run observe出力の要否確認の結論が出るまで書込範囲は未定。実装する場合は宣言を更新して再compileする')],
})
def('t12', {
  owns: [
    p('docs/00_product-contract.md'), p('docs/schemas'), p('src/runtime-contracts.mjs'),
    p('src/runtime-front-end.mjs'), p('src/todo-independence-contracts.mjs'),
    p('test/rc3-front-end.test.mjs'), p('test/rc3-runtime-contracts.test.mjs'),
    p('test/runtime-schema-distribution.test.mjs'), p('test/runtime-seam-resolve.test.mjs'),
    p('test/todo-independence-contracts.test.mjs'), p(EV('t12')),
  ],
  reads: ['src/todo-independence.mjs'],
  writes: [
    'docs/00_product-contract.md', 'docs/schemas', 'src/runtime-contracts.mjs',
    'src/runtime-front-end.mjs', 'src/todo-independence-contracts.mjs',
    'test/rc3-front-end.test.mjs', 'test/rc3-runtime-contracts.test.mjs',
    'test/runtime-schema-distribution.test.mjs', 'test/runtime-seam-resolve.test.mjs',
    'test/todo-independence-contracts.test.mjs', EV('t12'),
  ],
  affected_tests: [
    'test/rc3-front-end.test.mjs', 'test/rc3-runtime-contracts.test.mjs',
    'test/runtime-schema-distribution.test.mjs', 'test/runtime-seam-resolve.test.mjs',
    'test/todo-independence-contracts.test.mjs',
  ],
})
def('t13', {
  owns: [
    p('src/boundary-observation-compiler-v2.mjs'), p('src/runtime-front-end.mjs'),
    p('src/seam-proposal-queries.mjs'), p('src/todo-independence-contracts.mjs'),
    p('src/todo-independence.mjs'),
    p('test/rc3-front-end.test.mjs'), p('test/seam-proposal-queries.test.mjs'),
    p('test/todo-independence-compile.test.mjs'),
    p('test/todo-independence-contracts.test.mjs'), pc(EV('t13')),
  ],
  reads: ['src/runtime-contracts.mjs', 'src/todo-independence-contracts.mjs'],
  writes: [
    'src/boundary-observation-compiler-v2.mjs', 'src/runtime-front-end.mjs',
    'src/seam-proposal-queries.mjs', 'src/todo-independence-contracts.mjs',
    'src/todo-independence.mjs',
    'test/rc3-front-end.test.mjs', 'test/seam-proposal-queries.test.mjs',
    'test/todo-independence-compile.test.mjs',
    'test/todo-independence-contracts.test.mjs', EV('t13'),
  ],
  affected_tests: [
    'test/rc3-front-end.test.mjs',
    'test/seam-proposal-queries.test.mjs', 'test/todo-independence-compile.test.mjs',
    'test/todo-independence-contracts.test.mjs',
  ],
})
def('t14', {
  owns: [

    p('src/runtime-cli.mjs'),
    p('src/runtime-contracts.mjs'), p('src/runtime-decision-verifier.mjs'),
    p('src/runtime-diff-observer.mjs'), p('src/runtime-engine.mjs'),
    p('test/rc3-hold-recompile.test.mjs'), p('test/rc3-runtime-engine.test.mjs'),
    p('test/runtime-io-sentinel.test.mjs'),

    p('test/integration/runtime-seam-transform.integration.mjs'),
    pc('test/runtime-line-observation.test.mjs'), pc(EV('t14')),
  ],
  reads: ['src/runtime-front-end.mjs', 'src/runtime-hold-recompile.mjs'],
  writes: [

    'src/runtime-cli.mjs', 'src/runtime-contracts.mjs',
    'src/runtime-decision-verifier.mjs', 'src/runtime-diff-observer.mjs',
    'src/runtime-engine.mjs', 'test/rc3-hold-recompile.test.mjs',
    'test/rc3-runtime-engine.test.mjs', 'test/runtime-io-sentinel.test.mjs',

    'test/integration/runtime-seam-transform.integration.mjs',
    'test/runtime-line-observation.test.mjs', EV('t14'),
  ],
  affected_tests: [
    'test/rc3-hold-recompile.test.mjs', 'test/rc3-runtime-engine.test.mjs',
    'test/runtime-io-sentinel.test.mjs',

    'test/integration/runtime-seam-transform.integration.mjs',
    'test/runtime-line-observation.test.mjs',
  ],
  lines: [{
    line_id: 'src.runtime-diff-observer.mjs--finding-kind', role: 'writes',
    anchors: [
      { kind: 'path', path: 'src/runtime-diff-observer.mjs' },
      { kind: 'path', path: 'src/runtime-decision-verifier.mjs' },
    ],
  }],
})
def('t16', {
  owns: [pc('test/integration/line-resource.integration.mjs'), pc(EV('t16'))],
  reads: ['src/runtime-decision-verifier.mjs', 'src/runtime-diff-observer.mjs', 'src/runtime-front-end.mjs', 'test/integration/hold-transform-resume.integration.mjs'],
  writes: ['test/integration/line-resource.integration.mjs', EV('t16')],
  affected_tests: ['test/integration/line-resource.integration.mjs'],
  lines: [{
    line_id: 'src.runtime-diff-observer.mjs--finding-kind', role: 'reads',
    anchors: [
      { kind: 'path', path: 'src/runtime-diff-observer.mjs' },
      { kind: 'path', path: 'src/runtime-decision-verifier.mjs' },
    ],
  }],
})
def('t17', {
  owns: [p('src/runtime-cli.mjs'), pc(EV('t17'))],
  reads: ['src/runtime-engine.mjs', 'src/runtime-multi-epoch-store.mjs'],
  writes: ['src/runtime-cli.mjs', EV('t17')],
})
def('t20', {
  owns: [
    p('CHANGELOG.md'), p('docs/00_product-contract.md'), p('package-lock.json'),
    p('package.json'), p('scripts/gen-roundtable-witness.mjs'),
    p('test/todo-cli.test.mjs'), p('test/todo-store-atomic-commit.test.mjs'), pc(EV('t20')),
  ],
  writes: [
    'CHANGELOG.md', 'docs/00_product-contract.md', 'package-lock.json',
    'package.json', 'scripts/gen-roundtable-witness.mjs',
    'test/todo-cli.test.mjs', 'test/todo-store-atomic-commit.test.mjs', EV('t20'),
  ],
  state_effects: [se('npm-registry-quolu-lattice', 'state')],
})

// ---- peertable越境（実体はpeertable repoに書く。ここでは共有資源として宣言） ----
def('t4', {
  owns: [pc(EV('t4'))], writes: [EV('t4')],
  resources: ['pt-run-bridge'],
  state_effects: [se('pt-run-bridge', 'state')],
  unknowns: [unk('external_repo', 'peertable:skill/scripts/run-bridge.mjs 新規。本storeのsensorは観測できない')],
})
def('t5', {
  owns: [pc(EV('t5'))], writes: [EV('t5')],
  resources: ['pt-member-md', 'pt-skill-md'],
  state_effects: [se('pt-member-md', 'state'), se('pt-skill-md', 'state')],
  unknowns: [unk('external_repo', 'peertable:.team/roles/member.md と skill/SKILL.md')],
})
def('t6', {
  owns: [pc(EV('t6'))], writes: [EV('t6')],
  resources: ['pt-setup-sh'],
  state_effects: [se('pt-setup-sh', 'state')],
  unknowns: [unk('external_repo', 'peertable:skill/scripts/setup.sh')],
})
def('t8', {
  owns: [pc(EV('t8'))], writes: [EV('t8')],
  resources: ['pt-run-bridge'],
  state_effects: [se('pt-run-bridge', 'state')],
  unknowns: [unk('external_repo', 'peertable:skill/scripts/run-bridge.mjs 複数席対応')],
})
def('t9', {
  owns: [pc(EV('t9'))], writes: [EV('t9')],
  resources: ['pt-member-md', 'pt-plan-md', 'pt-skill-md'],
  state_effects: [se('pt-member-md', 'state'), se('pt-plan-md', 'state'), se('pt-skill-md', 'state')],
  unknowns: [unk('external_repo', 'peertable:docs/plan.md（決定25改訂）・憲章/member.md・skill/SKILL.md')],
})
def('t15', {
  owns: [pc(EV('t15'))], writes: [EV('t15')],
  resources: ['pt-skill-md'],
  state_effects: [se('pt-skill-md', 'state')],
  unknowns: [unk('external_repo', 'peertable:skill/SKILL.md witness生成手順へ線宣言書式')],
})
def('t18', {
  owns: [pc(EV('t18'))], writes: [EV('t18')],
  resources: ['pt-skill-md', 'pt-teardown-sh'],
  state_effects: [se('pt-skill-md', 'state'), se('pt-teardown-sh', 'state')],
  unknowns: [unk('external_repo', 'peertable:skill/scripts/teardown.sh と監査手順')],
})
def('t21', {
  owns: [pc(EV('t21'))], writes: [EV('t21')],
  resources: ['pt-plan-md'],
  state_effects: [se('npm-registry-quolu-peertable', 'state'), se('pt-plan-md', 'state')],
  unknowns: [unk('external_repo', 'peertable:docs/plan.md 決定追記とnpm publish')],
})

// ---- gate（受入実測。runの実験はrun storeへ触れるが宣言scopeはevidenceのみ） ----
def('t7', {
  owns: [
    p('package.json'), p('src/runtime-cli.mjs'), p('src/runtime-adapter-registry.mjs'),
    p('src/runtime-controller-protocol.mjs'), p('src/runtime-managed-supervisor.mjs'),
    p('src/runtime-work-order-controller.mjs'),
    p('test/runtime-adapter-registry-cli.test.mjs'),
    p('test/runtime-controller-protocol.test.mjs'),
    p('test/runtime-managed-supervisor.test.mjs'),
    p('test/runtime-work-order-controller.test.mjs'),
    p('test/integration/io-sentinel-live-run.integration.mjs'),
    pc('docs/schemas/lattice.runtime_adapter_capabilities.v2.schema.json'),
    pc('docs/schemas/lattice.runtime_adapter_registration_input.v2.schema.json'),
    pc('docs/adr/0161-controller-declares-host-driven-epoch.md'), pc(EV('t7')),
  ],
  reads: ['docs/adr/0126-distribute-scripted-adapter-controller.md'],
  writes: [
    'package.json', 'src/runtime-cli.mjs', 'src/runtime-adapter-registry.mjs',
    'src/runtime-controller-protocol.mjs', 'src/runtime-managed-supervisor.mjs',
    'src/runtime-work-order-controller.mjs',
    'test/runtime-adapter-registry-cli.test.mjs',
    'test/runtime-controller-protocol.test.mjs',
    'test/runtime-managed-supervisor.test.mjs',
    'test/runtime-work-order-controller.test.mjs',
    'test/integration/io-sentinel-live-run.integration.mjs',
    'docs/schemas/lattice.runtime_adapter_capabilities.v2.schema.json',
    'docs/schemas/lattice.runtime_adapter_registration_input.v2.schema.json',
    'docs/adr/0161-controller-declares-host-driven-epoch.md', EV('t7'),
  ],
  affected_tests: [
    'test/runtime-adapter-registry-cli.test.mjs',
    'test/runtime-controller-protocol.test.mjs',
    'test/runtime-managed-supervisor.test.mjs',
    'test/runtime-work-order-controller.test.mjs',
    'test/integration/io-sentinel-live-run.integration.mjs',
  ],
  state_effects: [
    se('lattice-run-store', 'state'), se('pt-setup-sh', 'state'),
    se('pt-teardown-sh', 'state'), se('pt-setup-runtime-exclude-repro', 'state'),
  ],
  resources: [
    'lattice-run-store', 'pt-setup-sh', 'pt-teardown-sh',
    'pt-setup-runtime-exclude-repro',
  ],
  unknowns: [
    unk('runtime_experiment', '実daemon・実席での一気通貫実測。.lattice/runs配下は実験ごとに生成'),
    unk('external_repo', 'peertable:skill/scripts/setup.sh・teardown.shとexperiments/setup-runtime-exclude-repro.mjs'),
  ],
})
def('t11', {
  owns: [pc(EV('t11'))], writes: [EV('t11')],
  state_effects: [se('lattice-run-store', 'state')],
  resources: ['lattice-run-store'],
  unknowns: [unk('runtime_experiment', '複数席runの実測')],
})
def('t19', {
  owns: [pc(EV('t19'))], writes: [EV('t19')],
  state_effects: [se('lattice-run-store', 'state')],
  resources: ['lattice-run-store'],
  unknowns: [unk('runtime_experiment', '実campaign 1本のmanaged run完走')],
})

const requested = process.argv.slice(2)
const subset = requested.length > 0 ? requested : ['t1', 't2', 't3', 't4', 't5', 't6', 't7']
if (subset.length > 8) { console.error('boundary compilerの上限は8 ToDo'); process.exit(1) }
for (const id of subset) if (!W[id]) { console.error(`未定義task: ${id}`); process.exit(1) }

const witnessSet = {
  schema: 'lattice.todo_witness_set.v5',
  project_id: 'lattice',
  plan_key: 'roundtable-exec-20260809',
  capacity: { executors: 4 },
  sensor_query_set: { queries: [{ id: 'witness-status', operation: 'status' }] },
  manual_witness: Object.fromEntries([...subset].sort().map(k => [k, W[k]])),
  witness_set_digest: '0'.repeat(64),
}
witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest')

const explained = explainTodoWitnessSet(witnessSet)
console.log(JSON.stringify(explained))
if (!explained.valid) process.exit(1)
writeFileSync(new URL('../.lattice/todo/witness/roundtable-exec-20260809.json', import.meta.url), canonicalizeTodoArtifact(witnessSet) + '\n')
console.log('written:', subset.join(','))
