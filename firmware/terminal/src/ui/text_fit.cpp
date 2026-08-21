#include "openjornada/screen.hpp"

#include <cstdint>

namespace openjornada {
namespace {

size_t nextBoundary(std::string_view value, size_t offset) {
  if (offset >= value.size()) return std::string_view::npos;
  const auto byte = static_cast<uint8_t>(value[offset]);
  if (byte <= 0x7FU) return offset + 1U;

  size_t length = 0;
  uint8_t secondMinimum = 0x80U;
  uint8_t secondMaximum = 0xBFU;
  if (byte >= 0xC2U && byte <= 0xDFU) {
    length = 2;
  } else if (byte >= 0xE0U && byte <= 0xEFU) {
    length = 3;
    if (byte == 0xE0U) secondMinimum = 0xA0U;
    if (byte == 0xEDU) secondMaximum = 0x9FU;
  } else if (byte >= 0xF0U && byte <= 0xF4U) {
    length = 4;
    if (byte == 0xF0U) secondMinimum = 0x90U;
    if (byte == 0xF4U) secondMaximum = 0x8FU;
  } else {
    return std::string_view::npos;
  }
  if (length > value.size() - offset) return std::string_view::npos;
  const auto second = static_cast<uint8_t>(value[offset + 1U]);
  if (second < secondMinimum || second > secondMaximum) {
    return std::string_view::npos;
  }
  for (size_t index = 2; index < length; ++index) {
    const auto continuation = static_cast<uint8_t>(value[offset + index]);
    if (continuation < 0x80U || continuation > 0xBFU) {
      return std::string_view::npos;
    }
  }
  return offset + length;
}

size_t validPrefix(std::string_view value) {
  size_t cursor = 0;
  while (cursor < value.size()) {
    const size_t next = nextBoundary(value, cursor);
    if (next == std::string_view::npos) break;
    cursor = next;
  }
  return cursor;
}

}  // namespace

bool validUtf8(std::string_view value) {
  return validPrefix(value) == value.size();
}

std::string fitUtf8ToWidth(std::string_view value, int maximumWidth,
                           const TextWidthMeasure& measure,
                           std::string_view suffix) {
  if (maximumWidth <= 0 || !measure) return {};
  const size_t validBytes = validPrefix(value);
  const bool needsSanitizing = validBytes != value.size();
  const std::string_view valid = value.substr(0, validBytes);
  if (!needsSanitizing && measure(valid) <= maximumWidth) {
    return std::string(valid);
  }

  const std::string safeSuffix =
      validUtf8(suffix) && measure(suffix) <= maximumWidth
          ? std::string(suffix)
          : std::string();
  size_t cursor = 0;
  size_t best = 0;
  while (cursor < valid.size()) {
    const size_t next = nextBoundary(valid, cursor);
    if (next == std::string_view::npos) break;
    std::string candidate(valid.substr(0, next));
    candidate += safeSuffix;
    if (measure(candidate) > maximumWidth) break;
    best = next;
    cursor = next;
  }
  std::string output(valid.substr(0, best));
  output += safeSuffix;
  return output;
}

}  // namespace openjornada
