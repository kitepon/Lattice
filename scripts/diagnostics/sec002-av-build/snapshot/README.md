# SEC002 AV capture implementation preparation

Owner: スノーホワイト。[境界・保存先](docs/OWNERSHIP.md)、[実装状態と不足](docs/IMPLEMENTATION.md)、[Windows fixture期待値](fixtures/EXPECTED.md)。

**PREPARATION ONLY — Windows未compile/未実行、binary無し。製品hook/caller/CI未変更。**
helperはfault metadataまでの候補。stack収集はsymbol探索境界が未検証のため無効で、実装未了。Win32成立・dispatch可能・元AV原因確定を主張しない。

手元のportable検査（Windows APIは実行しない）:

```
g++ -std=c++17 -Wall -Wextra -Werror -pedantic checks/policy-test.cpp -o checks/policy-test
./checks/policy-test
python3 checks/static-check.py
```

Windows recipeはbuild/build-msvc.ps1。将来別途許可されたcompiler/SDKで実行する。fixture EXEの起動はrecipeに含めない。秘密を含む任意path/env/argvを原本へ出力しない。
