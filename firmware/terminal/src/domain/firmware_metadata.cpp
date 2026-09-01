#include "openjornada/firmware_metadata.hpp"

#include <ArduinoJson.h>

#include <algorithm>
#include <string_view>

#include "openjornada/ota.hpp"
#include "openjornada/version.hpp"

namespace openjornada {

static_assert(kTerminalFirmwareVersion == "1.2.1",
              "Actualice los metadatos al cambiar la version del firmware");

#if defined(ARDUINO)
#define OPENJORNADA_FIRMWARE_METADATA_ATTRIBUTES                         \
  __attribute__((section(".rodata_custom_desc.ojfw"), used))
#else
#define OPENJORNADA_FIRMWARE_METADATA_ATTRIBUTES
#endif

extern "C" OPENJORNADA_FIRMWARE_METADATA_ATTRIBUTES const char
    kEmbeddedFirmwareMetadata[] =
    "OJFW_META_V1:{\"board\":\"m5stack-basic-core-v27\",\"protocolVersion\":1,"
    "\"firmwareVersion\":\"1.2.1\"}";

#undef OPENJORNADA_FIRMWARE_METADATA_ATTRIBUTES

namespace {

constexpr uint8_t kFirmwareProtocolVersion = 1;
constexpr size_t kFirmwareMarkerBytes = 13;

static_assert(kFirmwareMetadataPrefix.size() == kFirmwareMarkerBytes);

bool markerMatches(const uint8_t* candidate) {
  // Keep the sentinel split so the scanner itself cannot add a second marker
  // to a firmware image. Only kEmbeddedFirmwareMetadata contains it whole.
  constexpr std::string_view first = "OJFW_";
  constexpr std::string_view second = "META_V1:";
  for (size_t index = 0; index < first.size(); ++index) {
    if (candidate[index] != static_cast<uint8_t>(first[index])) return false;
  }
  for (size_t index = 0; index < second.size(); ++index) {
    if (candidate[first.size() + index] !=
        static_cast<uint8_t>(second[index])) {
      return false;
    }
  }
  return true;
}

const uint8_t* findMarker(const uint8_t* begin, const uint8_t* end) {
  if (static_cast<size_t>(end - begin) < kFirmwareMarkerBytes) return nullptr;
  const uint8_t* const last = end - kFirmwareMarkerBytes;
  for (const uint8_t* candidate = begin; candidate <= last; ++candidate) {
    if (markerMatches(candidate)) return candidate;
  }
  return nullptr;
}

std::optional<size_t> metadataJsonLength(const uint8_t* begin,
                                         size_t available) {
  const size_t limit = std::min(available, kFirmwareMetadataJsonMaxBytes);
  bool inString = false;
  bool escaped = false;
  for (size_t index = 0; index < limit; ++index) {
    const char byte = static_cast<char>(begin[index]);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte == '\\') {
        escaped = true;
      } else if (byte == '"') {
        inString = false;
      }
    } else if (byte == '"') {
      inString = true;
    } else if (byte == '}') {
      return index + 1U;
    }
  }
  return std::nullopt;
}

std::string canonicalMetadataJson(const FirmwareBuildMetadata& metadata) {
  return "{\"board\":\"" + metadata.board +
         "\",\"protocolVersion\":" +
         std::to_string(metadata.protocolVersion) +
         ",\"firmwareVersion\":\"" + metadata.firmwareVersion + "\"}";
}

}  // namespace

std::optional<FirmwareBuildMetadata> parseFirmwareBuildMetadata(
    const uint8_t* image, size_t size) {
  if (image == nullptr || size < kFirmwareMarkerBytes) {
    return std::nullopt;
  }
  const size_t scanSize = std::min(size, kFirmwareMetadataScanBytes);
  const uint8_t* const scanEnd = image + scanSize;
  const uint8_t* const marker = findMarker(image, scanEnd);
  if (marker == nullptr) return std::nullopt;
  const uint8_t* const afterMarker = marker + kFirmwareMarkerBytes;
  if (findMarker(afterMarker, scanEnd) != nullptr) return std::nullopt;

  const auto jsonLength = metadataJsonLength(
      afterMarker, static_cast<size_t>(scanEnd - afterMarker));
  if (!jsonLength.has_value()) return std::nullopt;
  const std::string_view json(reinterpret_cast<const char*>(afterMarker),
                              *jsonLength);
  ArduinoJson::JsonDocument document;
  const auto parseError = ArduinoJson::deserializeJson(
      document, json.data(), json.size(),
      ArduinoJson::DeserializationOption::NestingLimit(1));
  if (parseError || !document.is<ArduinoJson::JsonObjectConst>()) {
    return std::nullopt;
  }
  const auto object = document.as<ArduinoJson::JsonObjectConst>();
  if (object.size() != 3 || !object["board"].is<const char*>() ||
      !object["protocolVersion"].is<uint8_t>() ||
      !object["firmwareVersion"].is<const char*>()) {
    return std::nullopt;
  }
  FirmwareBuildMetadata metadata;
  metadata.board = object["board"].as<const char*>();
  metadata.protocolVersion = object["protocolVersion"].as<uint8_t>();
  metadata.firmwareVersion = object["firmwareVersion"].as<const char*>();
  if (canonicalMetadataJson(metadata) != json || metadata.board != kOtaBoard ||
      metadata.protocolVersion != kFirmwareProtocolVersion ||
      !compareSemanticVersions(metadata.firmwareVersion,
                               metadata.firmwareVersion)
           .has_value()) {
    return std::nullopt;
  }
  return metadata;
}

}  // namespace openjornada
