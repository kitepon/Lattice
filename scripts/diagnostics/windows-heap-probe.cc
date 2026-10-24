// Diagnostic only: inspect the calling fixture's default heap. Never change
// heap flags or host verifier policy. A private code marks probe detection,
// not the original corrupting native instruction.
#include <windows.h>
#include <node_api.h>

static napi_value Check(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint32_t phase = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      (argc && napi_get_value_uint32(env, argv[0], &phase) != napi_ok)) {
    napi_throw_type_error(env, nullptr, "heap probe phase must be uint32");
    return nullptr;
  }
  HANDLE heap = GetProcessHeap();
  if (!heap) {
    napi_throw_error(env, nullptr, "GetProcessHeap failed");
    return nullptr;
  }
  // Flags=0 preserves serialization. HeapValidate does not set LastError.
  if (!HeapValidate(heap, 0, nullptr)) {
    ULONG_PTR details[] = { phase, reinterpret_cast<ULONG_PTR>(heap), GetCurrentThreadId() };
    RaiseException(0xE0424C54, EXCEPTION_NONCONTINUABLE, 3, details);
    return nullptr;
  }
  napi_value result;
  if (napi_get_boolean(env, true, &result) != napi_ok) return nullptr;
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "check", NAPI_AUTO_LENGTH, Check, nullptr, &fn) != napi_ok ||
      napi_set_named_property(env, exports, "check", fn) != napi_ok) return nullptr;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
