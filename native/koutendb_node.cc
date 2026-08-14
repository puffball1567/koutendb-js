#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "koutendb.h"

namespace {

struct DbHandle {
  void *db;
};

napi_value Undefined(napi_env env) {
  napi_value v;
  napi_get_undefined(env, &v);
  return v;
}

napi_value Null(napi_env env) {
  napi_value v;
  napi_get_null(env, &v);
  return v;
}

void Throw(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
}

void ThrowLast(napi_env env) {
  const char *message = kouten_last_error();
  Throw(env, message && message[0] ? message : "KoutenDB C ABI error");
}

bool IsBuffer(napi_env env, napi_value value) {
  bool is_buffer = false;
  napi_is_buffer(env, value, &is_buffer);
  return is_buffer;
}

bool IsTypedArray(napi_env env, napi_value value) {
  bool is_typed_array = false;
  napi_is_typedarray(env, value, &is_typed_array);
  return is_typed_array;
}

bool IsArrayBuffer(napi_env env, napi_value value) {
  bool is_array_buffer = false;
  napi_is_arraybuffer(env, value, &is_array_buffer);
  return is_array_buffer;
}

bool IsNullOrUndefined(napi_env env, napi_value value) {
  napi_valuetype type;
  napi_typeof(env, value, &type);
  return type == napi_null || type == napi_undefined;
}

std::string StringArg(napi_env env, napi_value value) {
  size_t len = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &len);
  std::string s(len + 1, '\0');
  napi_get_value_string_utf8(env, value, s.data(), s.size(), &len);
  s.resize(len);
  return s;
}

int32_t IntArg(napi_env env, napi_value value) {
  int32_t out = 0;
  napi_get_value_int32(env, value, &out);
  return out;
}

double DoubleArg(napi_env env, napi_value value) {
  double out = 0.0;
  napi_get_value_double(env, value, &out);
  return out;
}

int64_t Int64Arg(napi_env env, napi_value value) {
  int64_t out = 0;
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type == napi_bigint) {
    bool lossless = false;
    napi_get_value_bigint_int64(env, value, &out, &lossless);
    if (!lossless) {
      Throw(env, "integer budget is outside int64 range");
      return -1;
    }
  } else {
    napi_get_value_int64(env, value, &out);
  }
  return out;
}

napi_value TextResult(napi_env env, void *p, size_t len) {
  if (p == nullptr) {
    ThrowLast(env);
    return nullptr;
  }
  napi_value out;
  napi_create_string_utf8(env, reinterpret_cast<const char *>(p), len, &out);
  kouten_free(p);
  return out;
}

DbHandle *DbArg(napi_env env, napi_value value) {
  DbHandle *handle = nullptr;
  napi_get_value_external(env, value, reinterpret_cast<void **>(&handle));
  if (handle == nullptr || handle->db == nullptr) {
    Throw(env, "KoutenDB handle is closed");
    return nullptr;
  }
  return handle;
}

kouten_id IdArg(napi_env env, napi_value value) {
  kouten_id id{};
  napi_value field;
  bool lossless = false;

  napi_get_named_property(env, value, "parent", &field);
  napi_get_value_bigint_uint64(env, field, &id.parent, &lossless);

  napi_get_named_property(env, value, "epoch", &field);
  uint32_t epoch = 0;
  napi_get_value_uint32(env, field, &epoch);
  id.epoch = epoch;

  napi_get_named_property(env, value, "seq", &field);
  uint32_t seq = 0;
  napi_get_value_uint32(env, field, &seq);
  id.seq = seq;

  napi_get_named_property(env, value, "tWrite", &field);
  napi_get_value_double(env, field, &id.t_write);

  return id;
}

napi_value IdObject(napi_env env, kouten_id id) {
  napi_value obj;
  napi_create_object(env, &obj);

  napi_value parent;
  napi_create_bigint_uint64(env, id.parent, &parent);
  napi_set_named_property(env, obj, "parent", parent);

  napi_value epoch;
  napi_create_uint32(env, id.epoch, &epoch);
  napi_set_named_property(env, obj, "epoch", epoch);

  napi_value seq;
  napi_create_uint32(env, id.seq, &seq);
  napi_set_named_property(env, obj, "seq", seq);

  napi_value t_write;
  napi_create_double(env, id.t_write, &t_write);
  napi_set_named_property(env, obj, "tWrite", t_write);

  return obj;
}

napi_value CodecString(napi_env env, int codec) {
  const char *name = "raw";
  switch (codec) {
    case KOUTEN_CODEC_RAW:
      name = "raw";
      break;
    case KOUTEN_CODEC_JSON:
      name = "json";
      break;
    case KOUTEN_CODEC_NIF:
      name = "nif";
      break;
    case KOUTEN_CODEC_BIF:
      name = "bif";
      break;
    default:
      name = "unknown";
      break;
  }
  napi_value out;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &out);
  return out;
}

void FinalizeDb(napi_env, void *data, void *) {
  DbHandle *handle = reinterpret_cast<DbHandle *>(data);
  if (handle != nullptr) {
    if (handle->db != nullptr) {
      kouten_close(handle->db);
      handle->db = nullptr;
    }
    delete handle;
  }
}

napi_value ExternalDb(napi_env env, void *db) {
  if (db == nullptr) {
    ThrowLast(env);
    return nullptr;
  }
  DbHandle *handle = new DbHandle{db};
  napi_value external;
  napi_create_external(env, handle, FinalizeDb, nullptr, &external);
  return external;
}

struct BytesArg {
  const void *data = nullptr;
  size_t len = 0;
};

size_t TypedArrayElementSize(napi_typedarray_type type) {
  switch (type) {
    case napi_int8_array:
    case napi_uint8_array:
    case napi_uint8_clamped_array:
      return 1;
    case napi_int16_array:
    case napi_uint16_array:
      return 2;
    case napi_int32_array:
    case napi_uint32_array:
    case napi_float32_array:
      return 4;
    case napi_float64_array:
    case napi_bigint64_array:
    case napi_biguint64_array:
      return 8;
    default:
      return 1;
  }
}

BytesArg DataArg(napi_env env, napi_value value, std::string &string_storage) {
  BytesArg out;
  if (IsBuffer(env, value)) {
    void *data = nullptr;
    size_t len = 0;
    napi_get_buffer_info(env, value, &data, &len);
    out.data = data;
    out.len = len;
    return out;
  }
  if (IsTypedArray(env, value)) {
    napi_typedarray_type type;
    size_t len = 0;
    void *data = nullptr;
    napi_value array_buffer;
    size_t byte_offset = 0;
    napi_get_typedarray_info(env, value, &type, &len, &data, &array_buffer, &byte_offset);
    out.data = data;
    out.len = len * TypedArrayElementSize(type);
    return out;
  }
  if (IsArrayBuffer(env, value)) {
    void *data = nullptr;
    size_t len = 0;
    napi_get_arraybuffer_info(env, value, &data, &len);
    out.data = data;
    out.len = len;
    return out;
  }
  string_storage = StringArg(env, value);
  out.data = string_storage.data();
  out.len = string_storage.size();
  return out;
}

struct FloatVecArg {
  const float *data = nullptr;
  size_t len = 0;
};

FloatVecArg VecArg(napi_env env, napi_value value) {
  FloatVecArg out;
  if (IsTypedArray(env, value)) {
    napi_typedarray_type type;
    size_t len = 0;
    void *data = nullptr;
    napi_value array_buffer;
    size_t byte_offset = 0;
    napi_get_typedarray_info(env, value, &type, &len, &data, &array_buffer, &byte_offset);
    if (type != napi_float32_array) {
      Throw(env, "vector must be a Float32Array");
      return out;
    }
    out.data = reinterpret_cast<const float *>(data);
    out.len = len;
    return out;
  }
  Throw(env, "vector must be a Float32Array");
  return out;
}

napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int nodes = argc > 0 ? IntArg(env, args[0]) : 8;
  return ExternalDb(env, kouten_open(nodes));
}

napi_value OpenDir(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "openDir requires nodes and dir");
    return nullptr;
  }
  int nodes = IntArg(env, args[0]);
  std::string dir = StringArg(env, args[1]);
  return ExternalDb(env, kouten_open_dir(nodes, dir.c_str()));
}

napi_value OpenDirOptions(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 4) {
    Throw(env, "openDirOptions requires nodes, dir, strongDurability, and diskBacked");
    return nullptr;
  }
  std::string dir = StringArg(env, args[1]);
  return ExternalDb(env, kouten_open_dir_options(
      IntArg(env, args[0]), dir.c_str(), IntArg(env, args[2]), IntArg(env, args[3])));
}

napi_value Connect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "connect requires peers");
    return nullptr;
  }
  std::string peers = StringArg(env, args[0]);
  return ExternalDb(env, kouten_connect(peers.c_str()));
}

napi_value ConnectAuth(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "connectAuth requires peers");
    return nullptr;
  }
  std::string peers = StringArg(env, args[0]);
  std::string username = argc > 1 ? StringArg(env, args[1]) : "";
  std::string password = argc > 2 ? StringArg(env, args[2]) : "";
  std::string auth_token = argc > 3 ? StringArg(env, args[3]) : "";
  std::string secret_key = argc > 4 ? StringArg(env, args[4]) : "";
  std::string galaxy = argc > 5 ? StringArg(env, args[5]) : "";
  return ExternalDb(env, kouten_connect_auth(peers.c_str(), username.c_str(),
                                            password.c_str(), auth_token.c_str(),
                                            secret_key.c_str(), galaxy.c_str()));
}

napi_value ConnectAuthTls(napi_env env, napi_callback_info info) {
  size_t argc = 10;
  napi_value args[10];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "connectAuthTls requires peers");
    return nullptr;
  }
  std::string peers = StringArg(env, args[0]);
  std::string username = argc > 1 ? StringArg(env, args[1]) : "";
  std::string password = argc > 2 ? StringArg(env, args[2]) : "";
  std::string auth_token = argc > 3 ? StringArg(env, args[3]) : "";
  std::string secret_key = argc > 4 ? StringArg(env, args[4]) : "";
  std::string galaxy = argc > 5 ? StringArg(env, args[5]) : "";
  int tls = argc > 6 ? IntArg(env, args[6]) : 0;
  std::string tls_ca_file = argc > 7 ? StringArg(env, args[7]) : "";
  std::string tls_server_name = argc > 8 ? StringArg(env, args[8]) : "";
  int tls_insecure_skip_verify = argc > 9 ? IntArg(env, args[9]) : 0;
  return ExternalDb(env, kouten_connect_auth_tls(
                             peers.c_str(), username.c_str(), password.c_str(),
                             auth_token.c_str(), secret_key.c_str(),
                             galaxy.c_str(), tls, tls_ca_file.c_str(),
                             tls_server_name.c_str(), tls_insecure_skip_verify));
}

napi_value AbiVersion(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_int32(env, kouten_abi_version(), &out);
  return out;
}

napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "close requires db handle");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_close(handle->db);
  handle->db = nullptr;
  return Undefined(env);
}

napi_value Put(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "put requires db, ring, and data");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string ring = StringArg(env, args[1]);
  std::string storage;
  BytesArg data = DataArg(env, args[2], storage);
  kouten_id id{};
  int rc = KOUTEN_ERR;
  if (argc >= 4) {
    FloatVecArg vec = VecArg(env, args[3]);
    if (vec.data == nullptr && vec.len == 0) return nullptr;
    rc = kouten_put_vec(handle->db, ring.c_str(), data.data, data.len, vec.data, vec.len, &id);
  } else {
    rc = kouten_put(handle->db, ring.c_str(), data.data, data.len, &id);
  }
  if (rc != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  return IdObject(env, id);
}

napi_value PutCodec(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 4) {
    Throw(env, "putCodec requires db, ring, data, and codec");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string ring = StringArg(env, args[1]);
  std::string storage;
  BytesArg data = DataArg(env, args[2], storage);
  int codec = IntArg(env, args[3]);
  kouten_id id{};
  int rc = KOUTEN_ERR;
  if (argc >= 5) {
    FloatVecArg vec = VecArg(env, args[4]);
    if (vec.data == nullptr && vec.len == 0) return nullptr;
    rc = kouten_put_vec_codec(handle->db, ring.c_str(), data.data, data.len,
                             codec, vec.data, vec.len, &id);
  } else {
    rc = kouten_put_codec(handle->db, ring.c_str(), data.data, data.len, codec, &id);
  }
  if (rc != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  return IdObject(env, id);
}

napi_value Get(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "get requires db and id");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_id id = IdArg(env, args[1]);
  size_t len = 0;
  void *p = kouten_get(handle->db, id, &len);
  if (p == nullptr) return Null(env);
  napi_value buf;
  napi_create_buffer_copy(env, len, p, nullptr, &buf);
  kouten_free(p);
  return buf;
}

napi_value GetEncoded(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "getEncoded requires db and id");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_id id = IdArg(env, args[1]);
  size_t len = 0;
  int codec = KOUTEN_CODEC_RAW;
  void *p = kouten_get_codec(handle->db, id, &len, &codec);
  if (p == nullptr) return Null(env);

  napi_value out;
  napi_create_object(env, &out);
  napi_value data;
  napi_create_buffer_copy(env, len, p, nullptr, &data);
  kouten_free(p);
  napi_set_named_property(env, out, "data", data);
  napi_set_named_property(env, out, "codec", CodecString(env, codec));
  return out;
}

napi_value Exists(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "exists requires db and id");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  int rc = kouten_exists(handle->db, IdArg(env, args[1]));
  if (rc < 0) {
    ThrowLast(env);
    return nullptr;
  }
  napi_value out;
  napi_get_boolean(env, rc != 0, &out);
  return out;
}

napi_value Update(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "update requires db, id, and data");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string storage;
  BytesArg data = DataArg(env, args[2], storage);
  int rc = argc >= 4
      ? kouten_update_codec(handle->db, IdArg(env, args[1]), data.data, data.len,
                            IntArg(env, args[3]))
      : kouten_update(handle->db, IdArg(env, args[1]), data.data, data.len);
  if (rc != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  return Undefined(env);
}

napi_value Remove(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "remove requires db and id");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  if (kouten_remove(handle->db, IdArg(env, args[1])) != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  return Undefined(env);
}

napi_value BatchGet(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "batchGet requires db and ids");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;

  bool is_array = false;
  napi_is_array(env, args[1], &is_array);
  if (!is_array) {
    Throw(env, "ids must be an array");
    return nullptr;
  }

  uint32_t len = 0;
  napi_get_array_length(env, args[1], &len);
  std::vector<kouten_id> ids(len);
  for (uint32_t i = 0; i < len; ++i) {
    napi_value item;
    napi_get_element(env, args[1], i, &item);
    ids[i] = IdArg(env, item);
  }

  kouten_batch_result *br = kouten_batch_get(handle->db, ids.data(), ids.size());
  if (br == nullptr) {
    ThrowLast(env);
    return nullptr;
  }

  napi_value out;
  napi_create_array_with_length(env, br->len, &out);
  for (size_t i = 0; i < br->len; ++i) {
    if (br->values[i].data == nullptr) {
      napi_set_element(env, out, static_cast<uint32_t>(i), Null(env));
      continue;
    }
    napi_value buf;
    napi_create_buffer_copy(env, br->values[i].len, br->values[i].data, nullptr, &buf);
    napi_set_element(env, out, static_cast<uint32_t>(i), buf);
  }

  kouten_batch_get_free(br);
  return out;
}

napi_value Query(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "query requires db, id, and selection");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_id id = IdArg(env, args[1]);
  std::string selection = StringArg(env, args[2]);
  size_t len = 0;
  void *p = kouten_query(handle->db, id, selection.c_str(), &len);
  if (p == nullptr) {
    ThrowLast(env);
    return nullptr;
  }
  napi_value buf;
  napi_create_buffer_copy(env, len, p, nullptr, &buf);
  kouten_free(p);
  return buf;
}

napi_value ReadRingJson(napi_env env, napi_callback_info info) {
  size_t argc = 11;
  napi_value args[11];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 11) {
    Throw(env, "readRingJson requires db, ring, filterJson, selection, limit, cursor, pagination, page, pageLimit, sortField, and sortDesc");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string ring = StringArg(env, args[1]);
  std::string filter_json = StringArg(env, args[2]);
  std::string selection = StringArg(env, args[3]);
  int limit = IntArg(env, args[4]);
  std::string cursor = StringArg(env, args[5]);
  int pagination = IntArg(env, args[6]);
  int page = IntArg(env, args[7]);
  int page_limit = IntArg(env, args[8]);
  std::string sort_field = StringArg(env, args[9]);
  int sort_desc = IntArg(env, args[10]);
  size_t len = 0;
  void *p = kouten_read_ring_json(handle->db, ring.c_str(), filter_json.c_str(),
                                 selection.c_str(), limit, cursor.c_str(),
                                 pagination, page, page_limit,
                                 sort_field.c_str(), sort_desc, &len);
  if (p == nullptr) {
    ThrowLast(env);
    return nullptr;
  }
  napi_value str;
  napi_create_string_utf8(env, reinterpret_cast<const char *>(p), len, &str);
  kouten_free(p);
  return str;
}

napi_value Retrieve(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "retrieve requires db and vector");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  FloatVecArg vec = VecArg(env, args[1]);
  std::string ring = argc > 2 ? StringArg(env, args[2]) : "";
  int budget = argc > 3 ? IntArg(env, args[3]) : 8;
  int top_rings = argc > 4 ? IntArg(env, args[4]) : 0;
  int focus = argc > 5 ? IntArg(env, args[5]) : 0;
  kouten_retrieve_result *rr = kouten_retrieve(handle->db, vec.data, vec.len,
                                             ring.c_str(), budget, top_rings, focus);
  if (rr == nullptr) {
    ThrowLast(env);
    return nullptr;
  }

  napi_value out;
  napi_create_object(env, &out);
  napi_value hits;
  napi_create_array_with_length(env, rr->len, &hits);
  for (size_t i = 0; i < rr->len; ++i) {
    napi_value hit;
    napi_create_object(env, &hit);
    napi_set_named_property(env, hit, "id", IdObject(env, rr->hits[i].id));
    napi_value score;
    napi_create_double(env, rr->hits[i].score, &score);
    napi_set_named_property(env, hit, "score", score);
    napi_value payload;
    napi_create_buffer_copy(env, rr->hits[i].payload_len, rr->hits[i].payload,
                            nullptr, &payload);
    napi_set_named_property(env, hit, "payload", payload);
    napi_set_element(env, hits, static_cast<uint32_t>(i), hit);
  }
  napi_set_named_property(env, out, "hits", hits);

  napi_value stats;
  napi_create_object(env, &stats);
  auto set_i32 = [&](const char *name, int value) {
    napi_value v;
    napi_create_int32(env, value, &v);
    napi_set_named_property(env, stats, name, v);
  };
  set_i32("totalVectors", rr->total_vectors);
  set_i32("scanned", rr->scanned);
  set_i32("skippedVectors", rr->skipped_vectors);
  set_i32("returned", rr->returned);
  set_i32("ringsTouched", rr->rings_touched);
  set_i32("payloadBytes", rr->payload_bytes);
  set_i32("estimatedTokens", rr->estimated_tokens);
  set_i32("fanoutNodes", rr->fanout_nodes);
  napi_value reduction;
  napi_create_double(env, rr->candidate_reduction, &reduction);
  napi_set_named_property(env, stats, "candidateReduction", reduction);
  napi_set_named_property(env, out, "stats", stats);
  kouten_retrieve_free(rr);
  return out;
}

napi_value Atlas(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "atlas requires db");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  const float *vec_data = nullptr;
  size_t vec_len = 0;
  if (argc > 1 && !IsNullOrUndefined(env, args[1])) {
    FloatVecArg vec = VecArg(env, args[1]);
    vec_data = vec.data;
    vec_len = vec.len;
  }
  int max_dims = argc > 2 ? IntArg(env, args[2]) : 8;
  size_t len = 0;
  void *p = kouten_atlas(handle->db, vec_data, vec_len, max_dims, &len);
  if (p == nullptr) {
    ThrowLast(env);
    return nullptr;
  }
  napi_value str;
  napi_create_string_utf8(env, reinterpret_cast<const char *>(p), len, &str);
  kouten_free(p);
  return str;
}

napi_value Metrics(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "metrics requires db and format");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  size_t len = 0;
  void *p = kouten_metrics_text(handle->db, IntArg(env, args[1]), &len);
  return TextResult(env, p, len);
}

napi_value SegmentStatus(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "segmentStatus requires db, staleRatio, and minStaleRecords");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  size_t len = 0;
  void *p = kouten_segment_status_json(
      handle->db, DoubleArg(env, args[1]), IntArg(env, args[2]), &len);
  return TextResult(env, p, len);
}

napi_value SegmentMaintenance(napi_env env, napi_callback_info info, bool run) {
  size_t argc = 6;
  napi_value args[6];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 6) {
    Throw(env, "segment maintenance requires db and five policy values");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  size_t len = 0;
  void *p = run
      ? kouten_segment_maintenance_run_json(
            handle->db, DoubleArg(env, args[1]), IntArg(env, args[2]),
            IntArg(env, args[3]), Int64Arg(env, args[4]), Int64Arg(env, args[5]), &len)
      : kouten_segment_maintenance_plan_json(
            handle->db, DoubleArg(env, args[1]), IntArg(env, args[2]),
            IntArg(env, args[3]), Int64Arg(env, args[4]), Int64Arg(env, args[5]), &len);
  return TextResult(env, p, len);
}

napi_value SegmentMaintenancePlan(napi_env env, napi_callback_info info) {
  return SegmentMaintenance(env, info, false);
}

napi_value SegmentMaintenanceRun(napi_env env, napi_callback_info info) {
  return SegmentMaintenance(env, info, true);
}

napi_value SegmentMaintenanceStatus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "segmentMaintenanceStatus requires db");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  size_t len = 0;
  void *p = kouten_segment_maintenance_status_json(handle->db, &len);
  return TextResult(env, p, len);
}

napi_value SegmentMaintenanceRecover(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "segmentMaintenanceRecover requires db");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  int recovered = 0;
  if (kouten_segment_maintenance_recover(handle->db, &recovered) != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  napi_value out;
  napi_get_boolean(env, recovered != 0, &out);
  return out;
}

napi_value CheckpointCreate(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "checkpointCreate requires db, root, and checkpointId");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string root = StringArg(env, args[1]);
  std::string id = StringArg(env, args[2]);
  size_t len = 0;
  void *p = kouten_checkpoint_create_json(
      handle->db, root.empty() ? nullptr : root.c_str(),
      id.empty() ? nullptr : id.c_str(), &len);
  return TextResult(env, p, len);
}

napi_value CheckpointPathCall(napi_env env, napi_callback_info info, int operation) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "checkpoint operation requires a path");
    return nullptr;
  }
  if ((operation == 2 || operation == 4) && argc < 2) {
    Throw(env, "checkpoint operation requires a second argument");
    return nullptr;
  }
  if (operation == 3 && argc < 3) {
    Throw(env, "checkpoint restore requires checkpointDir, dataDir, and overwrite");
    return nullptr;
  }
  std::string first = StringArg(env, args[0]);
  size_t len = 0;
  void *p = nullptr;
  if (operation == 0) {
    p = kouten_checkpoint_status_json(first.c_str(), &len);
  } else if (operation == 1) {
    p = kouten_checkpoint_list_json(first.c_str(), &len);
  } else if (operation == 2) {
    p = kouten_checkpoint_cleanup_json(first.c_str(), IntArg(env, args[1]), &len);
  } else if (operation == 3) {
    std::string second = StringArg(env, args[1]);
    p = kouten_checkpoint_restore_json(first.c_str(), second.c_str(), IntArg(env, args[2]), &len);
  } else {
    p = kouten_checkpoint_metrics_text(first.c_str(), IntArg(env, args[1]), &len);
  }
  return TextResult(env, p, len);
}

napi_value CheckpointStatus(napi_env env, napi_callback_info info) {
  return CheckpointPathCall(env, info, 0);
}
napi_value CheckpointList(napi_env env, napi_callback_info info) {
  return CheckpointPathCall(env, info, 1);
}
napi_value CheckpointCleanup(napi_env env, napi_callback_info info) {
  return CheckpointPathCall(env, info, 2);
}
napi_value CheckpointRestore(napi_env env, napi_callback_info info) {
  return CheckpointPathCall(env, info, 3);
}
napi_value CheckpointMetrics(napi_env env, napi_callback_info info) {
  return CheckpointPathCall(env, info, 4);
}

napi_value Locate(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "locate requires db and id");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_id id = IdArg(env, args[1]);
  double at = argc > 2 ? DoubleArg(env, args[2]) : -1.0;
  int node = kouten_locate(handle->db, id, at);
  napi_value out;
  napi_create_int32(env, node, &out);
  return out;
}

napi_value Now(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "now requires db");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  napi_value out;
  napi_create_double(env, kouten_now(handle->db), &out);
  return out;
}

napi_value Advance(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "advance requires db and dt");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_advance(handle->db, DoubleArg(env, args[1]));
  return Undefined(env);
}

napi_value NextVisit(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "nextVisit requires db, id, and node");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_id id = IdArg(env, args[1]);
  int node = IntArg(env, args[2]);
  napi_value out;
  napi_create_double(env, kouten_next_visit(handle->db, id, node), &out);
  return out;
}

napi_value NextJoin(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "nextJoin requires db and two ids");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  kouten_id a = IdArg(env, args[1]);
  kouten_id b = IdArg(env, args[2]);
  napi_value out;
  napi_create_double(env, kouten_next_join(handle->db, a, b), &out);
  return out;
}

napi_value ConfigureRing(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "configureRing requires db, ring, and period");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string ring = StringArg(env, args[1]);
  double period = DoubleArg(env, args[2]);
  if (kouten_ring_configure(handle->db, ring.c_str(), period) != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  return Undefined(env);
}

napi_value SetGalaxyDescription(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    Throw(env, "setGalaxyDescription requires db and description");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string description = StringArg(env, args[1]);
  if (kouten_set_galaxy_description(handle->db, description.c_str()) != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  return Undefined(env);
}

napi_value SetRingDescription(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    Throw(env, "setRingDescription requires db, ring, and description");
    return nullptr;
  }
  DbHandle *handle = DbArg(env, args[0]);
  if (handle == nullptr) return nullptr;
  std::string ring = StringArg(env, args[1]);
  std::string description = StringArg(env, args[2]);
  if (kouten_set_ring_description(handle->db, ring.c_str(), description.c_str()) != KOUTEN_OK) {
    ThrowLast(env);
    return nullptr;
  }
  return Undefined(env);
}

napi_value Init(napi_env env, napi_value exports) {
  kouten_init();
  napi_property_descriptor props[] = {
    {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openDir", nullptr, OpenDir, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openDirOptions", nullptr, OpenDirOptions, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"connect", nullptr, Connect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"connectAuth", nullptr, ConnectAuth, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"connectAuthTls", nullptr, ConnectAuthTls, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"abiVersion", nullptr, AbiVersion, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"put", nullptr, Put, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"putCodec", nullptr, PutCodec, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"get", nullptr, Get, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getEncoded", nullptr, GetEncoded, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"exists", nullptr, Exists, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"update", nullptr, Update, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"batchGet", nullptr, BatchGet, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"query", nullptr, Query, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readRingJson", nullptr, ReadRingJson, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"retrieve", nullptr, Retrieve, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"atlas", nullptr, Atlas, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"metrics", nullptr, Metrics, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"segmentStatus", nullptr, SegmentStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"segmentMaintenancePlan", nullptr, SegmentMaintenancePlan, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"segmentMaintenanceRun", nullptr, SegmentMaintenanceRun, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"segmentMaintenanceStatus", nullptr, SegmentMaintenanceStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"segmentMaintenanceRecover", nullptr, SegmentMaintenanceRecover, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkpointCreate", nullptr, CheckpointCreate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkpointStatus", nullptr, CheckpointStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkpointList", nullptr, CheckpointList, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkpointCleanup", nullptr, CheckpointCleanup, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkpointRestore", nullptr, CheckpointRestore, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkpointMetrics", nullptr, CheckpointMetrics, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"locate", nullptr, Locate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"now", nullptr, Now, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"advance", nullptr, Advance, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"nextVisit", nullptr, NextVisit, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"nextJoin", nullptr, NextJoin, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"configureRing", nullptr, ConfigureRing, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setGalaxyDescription", nullptr, SetGalaxyDescription, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setRingDescription", nullptr, SetRingDescription, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
