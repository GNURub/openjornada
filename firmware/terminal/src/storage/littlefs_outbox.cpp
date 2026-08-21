#include "openjornada/outbox.hpp"

#ifdef ARDUINO
#include <LittleFS.h>

namespace openjornada {

bool LittleFsOutboxStorage::begin() { return LittleFS.begin(false); }

bool LittleFsOutboxStorage::exists(const char* path) const {
  return LittleFS.exists(path);
}

bool LittleFsOutboxStorage::read(const char* path,
                                 std::vector<uint8_t>& output) const {
  File file = LittleFS.open(path, "r");
  if (!file || file.isDirectory()) {
    if (file) file.close();
    return false;
  }
  const size_t length = file.size();
  output.resize(length);
  const size_t read = length == 0 ? 0 : file.read(output.data(), length);
  file.close();
  return read == length;
}

bool LittleFsOutboxStorage::appendAndFlush(
    const char* path, const std::vector<uint8_t>& bytes) {
  File file = LittleFS.open(path, "a");
  if (!file) return false;
  const size_t written =
      bytes.empty() ? 0 : file.write(bytes.data(), bytes.size());
  file.flush();
  file.close();
  return written == bytes.size();
}

bool LittleFsOutboxStorage::writeAndFlush(
    const char* path, const std::vector<uint8_t>& bytes) {
  File file = LittleFS.open(path, "w");
  if (!file) return false;
  const size_t written =
      bytes.empty() ? 0 : file.write(bytes.data(), bytes.size());
  file.flush();
  file.close();
  return written == bytes.size();
}

bool LittleFsOutboxStorage::remove(const char* path) {
  return !LittleFS.exists(path) || LittleFS.remove(path);
}

bool LittleFsOutboxStorage::rename(const char* from, const char* to) {
  return !LittleFS.exists(to) && LittleFS.rename(from, to);
}

}  // namespace openjornada
#endif
