#include "openjornada/outbox.hpp"

#ifdef ARDUINO
#include <LittleFS.h>

namespace openjornada {

LittleFsOutboxStorage::~LittleFsOutboxStorage() { closeReadSessions(); }

File* LittleFsOutboxStorage::openReadSession(const char* path) const {
  // Two slots keep the action and completion journals open while scanQueue
  // alternates between them. Mutations invalidate only the affected paths.
  for (size_t index = 0; index < readFiles_.size(); ++index) {
    if (readFiles_[index] && readPaths_[index] == path) {
      return &readFiles_[index];
    }
  }
  size_t slot = readFiles_.size();
  for (size_t index = 0; index < readFiles_.size(); ++index) {
    if (!readFiles_[index]) {
      slot = index;
      break;
    }
  }
  if (slot == readFiles_.size()) {
    slot = nextReadSlot_++ % readFiles_.size();
  }
  if (readFiles_[slot]) readFiles_[slot].close();
  readFiles_[slot] = LittleFS.open(path, "r");
  if (!readFiles_[slot] || readFiles_[slot].isDirectory()) {
    if (readFiles_[slot]) readFiles_[slot].close();
    readFiles_[slot] = File();
    readPaths_[slot].clear();
    return nullptr;
  }
  readPaths_[slot] = path;
  return &readFiles_[slot];
}

void LittleFsOutboxStorage::closeReadSessions() const {
  for (size_t index = 0; index < readFiles_.size(); ++index) {
    if (readFiles_[index]) readFiles_[index].close();
    readFiles_[index] = File();
    readPaths_[index].clear();
  }
  nextReadSlot_ = 0;
}

void LittleFsOutboxStorage::closeReadSession(const char* path) const {
  for (size_t index = 0; index < readFiles_.size(); ++index) {
    if (readFiles_[index] && readPaths_[index] == path) {
      readFiles_[index].close();
      readFiles_[index] = File();
      readPaths_[index].clear();
    }
  }
}

bool LittleFsOutboxStorage::begin() {
  closeReadSessions();
  return LittleFS.begin(false);
}

bool LittleFsOutboxStorage::exists(const char* path) const {
  return LittleFS.exists(path);
}

bool LittleFsOutboxStorage::size(const char* path, size_t& output) const {
  File* file = openReadSession(path);
  if (file == nullptr) return false;
  output = file->size();
  return true;
}

bool LittleFsOutboxStorage::read(const char* path, size_t offset,
                                 uint8_t* output, size_t length) const {
  File* file = openReadSession(path);
  if (file == nullptr || !file->seek(offset, SeekSet)) return false;
  const size_t read = length == 0 ? 0 : file->read(output, length);
  return read == length;
}

bool LittleFsOutboxStorage::appendAndFlush(
    const char* path, const std::vector<uint8_t>& bytes) {
  closeReadSession(path);
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
  closeReadSession(path);
  File file = LittleFS.open(path, "w");
  if (!file) return false;
  const size_t written =
      bytes.empty() ? 0 : file.write(bytes.data(), bytes.size());
  file.flush();
  file.close();
  return written == bytes.size();
}

bool LittleFsOutboxStorage::remove(const char* path) {
  closeReadSession(path);
  return !LittleFS.exists(path) || LittleFS.remove(path);
}

bool LittleFsOutboxStorage::rename(const char* from, const char* to) {
  closeReadSession(from);
  closeReadSession(to);
  return !LittleFS.exists(to) && LittleFS.rename(from, to);
}

}  // namespace openjornada
#endif
