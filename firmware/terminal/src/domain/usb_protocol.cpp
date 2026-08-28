#include "openjornada/usb_protocol.hpp"

#include <algorithm>
#include <array>
#include <limits>
#include <optional>
#include <utility>

#include "openjornada/ojp.hpp"
#include "openjornada/ota.hpp"

namespace openjornada {
namespace {

constexpr std::string_view kControlPrefix = "OJUSB/1 ";
constexpr size_t kRequestIdBytes = 16;
constexpr size_t kRequestIdCharacters = 22;

bool validUtf8(std::string_view input) {
  size_t cursor = 0;
  while (cursor < input.size()) {
    const uint8_t first = static_cast<uint8_t>(input[cursor++]);
    if (first <= 0x7fU) continue;
    uint32_t codePoint = 0;
    size_t continuationCount = 0;
    uint32_t minimum = 0;
    if (first >= 0xc2U && first <= 0xdfU) {
      codePoint = first & 0x1fU;
      continuationCount = 1;
      minimum = 0x80U;
    } else if (first >= 0xe0U && first <= 0xefU) {
      codePoint = first & 0x0fU;
      continuationCount = 2;
      minimum = 0x800U;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      codePoint = first & 0x07U;
      continuationCount = 3;
      minimum = 0x10000U;
    } else {
      return false;
    }
    if (continuationCount > input.size() - cursor) return false;
    for (size_t index = 0; index < continuationCount; ++index) {
      const uint8_t byte = static_cast<uint8_t>(input[cursor++]);
      if ((byte & 0xc0U) != 0x80U) return false;
      codePoint = (codePoint << 6U) | (byte & 0x3fU);
    }
    if (codePoint < minimum || codePoint > 0x10ffffU ||
        (codePoint >= 0xd800U && codePoint <= 0xdfffU)) {
      return false;
    }
  }
  return true;
}

void skipJsonWhitespace(std::string_view json, size_t& cursor) {
  while (cursor < json.size() &&
         (json[cursor] == ' ' || json[cursor] == '\t' ||
          json[cursor] == '\r' || json[cursor] == '\n')) {
    ++cursor;
  }
}

int hexValue(char byte) {
  if (byte >= '0' && byte <= '9') return byte - '0';
  if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
  if (byte >= 'A' && byte <= 'F') return byte - 'A' + 10;
  return -1;
}

bool scanJsonString(std::string_view json, size_t& cursor,
                    std::string* decoded = nullptr) {
  if (cursor >= json.size() || json[cursor++] != '"') return false;
  while (cursor < json.size()) {
    const unsigned char byte = json[cursor++];
    if (byte == '"') return true;
    if (byte < 0x20U) return false;
    if (byte != '\\') {
      if (decoded != nullptr) decoded->push_back(static_cast<char>(byte));
      continue;
    }
    if (cursor >= json.size()) return false;
    const char escaped = json[cursor++];
    if (escaped == 'u') {
      if (json.size() - cursor < 4U) return false;
      uint16_t codePoint = 0;
      for (size_t index = 0; index < 4U; ++index) {
        const int value = hexValue(json[cursor++]);
        if (value < 0) return false;
        codePoint = static_cast<uint16_t>((codePoint << 4U) | value);
      }
      if (decoded != nullptr) {
        if (codePoint <= 0x7fU) {
          decoded->push_back(static_cast<char>(codePoint));
        } else {
          decoded->append("\\u");
          decoded->append(json.substr(cursor - 4U, 4U));
        }
      }
      continue;
    }
    char value = escaped;
    switch (escaped) {
      case 'b': value = '\b'; break;
      case 'f': value = '\f'; break;
      case 'n': value = '\n'; break;
      case 'r': value = '\r'; break;
      case 't': value = '\t'; break;
      case '"':
      case '\\':
      case '/': break;
      default: return false;
    }
    if (decoded != nullptr) decoded->push_back(value);
  }
  return false;
}

bool scanJsonValue(std::string_view json, size_t& cursor);

bool scanJsonObject(std::string_view json, size_t& cursor) {
  if (cursor >= json.size() || json[cursor++] != '{') return false;
  std::vector<std::string> keys;
  skipJsonWhitespace(json, cursor);
  if (cursor < json.size() && json[cursor] == '}') {
    ++cursor;
    return true;
  }
  while (cursor < json.size()) {
    std::string key;
    if (!scanJsonString(json, cursor, &key) ||
        std::find(keys.begin(), keys.end(), key) != keys.end()) {
      return false;
    }
    keys.push_back(std::move(key));
    skipJsonWhitespace(json, cursor);
    if (cursor >= json.size() || json[cursor++] != ':') return false;
    skipJsonWhitespace(json, cursor);
    if (!scanJsonValue(json, cursor)) return false;
    skipJsonWhitespace(json, cursor);
    if (cursor >= json.size()) return false;
    const char delimiter = json[cursor++];
    if (delimiter == '}') return true;
    if (delimiter != ',') return false;
    skipJsonWhitespace(json, cursor);
  }
  return false;
}

bool scanJsonArray(std::string_view json, size_t& cursor) {
  if (cursor >= json.size() || json[cursor++] != '[') return false;
  skipJsonWhitespace(json, cursor);
  if (cursor < json.size() && json[cursor] == ']') {
    ++cursor;
    return true;
  }
  while (cursor < json.size()) {
    if (!scanJsonValue(json, cursor)) return false;
    skipJsonWhitespace(json, cursor);
    if (cursor >= json.size()) return false;
    const char delimiter = json[cursor++];
    if (delimiter == ']') return true;
    if (delimiter != ',') return false;
    skipJsonWhitespace(json, cursor);
  }
  return false;
}

bool scanJsonValue(std::string_view json, size_t& cursor) {
  if (cursor >= json.size()) return false;
  if (json[cursor] == '{') return scanJsonObject(json, cursor);
  if (json[cursor] == '[') return scanJsonArray(json, cursor);
  if (json[cursor] == '"') return scanJsonString(json, cursor);
  const size_t start = cursor;
  while (cursor < json.size() && json[cursor] != ',' && json[cursor] != '}' &&
         json[cursor] != ']' && json[cursor] != ' ' && json[cursor] != '\t' &&
         json[cursor] != '\r' && json[cursor] != '\n') {
    ++cursor;
  }
  return cursor != start;
}

bool hasUniqueObjectKeys(std::string_view json) {
  size_t cursor = 0;
  skipJsonWhitespace(json, cursor);
  if (!scanJsonValue(json, cursor)) return false;
  skipJsonWhitespace(json, cursor);
  return cursor == json.size();
}

int base64UrlValue(char byte) {
  if (byte >= 'A' && byte <= 'Z') return byte - 'A';
  if (byte >= 'a' && byte <= 'z') return byte - 'a' + 26;
  if (byte >= '0' && byte <= '9') return byte - '0' + 52;
  if (byte == '-') return 62;
  if (byte == '_') return 63;
  return -1;
}

bool validRequestId(std::string_view id) {
  if (id.size() != kRequestIdCharacters) return false;
  uint32_t accumulator = 0;
  unsigned bits = 0;
  size_t decodedBytes = 0;
  for (const char byte : id) {
    const int value = base64UrlValue(byte);
    if (value < 0) return false;
    accumulator = (accumulator << 6U) | static_cast<uint32_t>(value);
    bits += 6U;
    if (bits >= 8U) {
      bits -= 8U;
      ++decodedBytes;
    }
  }
  if (decodedBytes != kRequestIdBytes || bits != 4U) return false;
  return (accumulator & 0x0fU) == 0U;
}

std::optional<UsbCommand> parseCommand(std::string_view command) {
  if (command == "hello") return UsbCommand::Hello;
  if (command == "status") return UsbCommand::Status;
  if (command == "doctor") return UsbCommand::Doctor;
  if (command == "logs_subscribe") return UsbCommand::LogsSubscribe;
  if (command == "provision") return UsbCommand::Provision;
  if (command == "reboot") return UsbCommand::Reboot;
  if (command == "factory_reset") return UsbCommand::FactoryReset;
  if (command == "firmware_begin") return UsbCommand::FirmwareBegin;
  if (command == "firmware_commit") return UsbCommand::FirmwareCommit;
  if (command == "set_baud") return UsbCommand::SetBaud;
  if (command == "baud_ready") return UsbCommand::BaudReady;
  if (command == "cancel") return UsbCommand::Cancel;
  return std::nullopt;
}

bool emptyPayloadCommand(UsbCommand command) {
  switch (command) {
    case UsbCommand::Hello:
    case UsbCommand::Status:
    case UsbCommand::Doctor:
    case UsbCommand::LogsSubscribe:
    case UsbCommand::Reboot:
    case UsbCommand::FactoryReset:
    case UsbCommand::FirmwareCommit:
    case UsbCommand::BaudReady:
    case UsbCommand::Cancel: return true;
    case UsbCommand::Provision:
    case UsbCommand::FirmwareBegin:
    case UsbCommand::SetBaud: return false;
  }
  return false;
}

bool validLowerHexSha256(std::string_view value) {
  return value.size() == 64U &&
         std::all_of(value.begin(), value.end(), [](char byte) {
           return (byte >= '0' && byte <= '9') ||
                  (byte >= 'a' && byte <= 'f');
         });
}

bool parsePayload(UsbCommand command, ArduinoJson::JsonObjectConst payload,
                  UsbControlRequest& request) {
  if (emptyPayloadCommand(command)) return payload.size() == 0U;
  if (command == UsbCommand::Provision) {
    if (payload.size() != 1U || !payload["ojp"].is<const char*>()) return false;
    const std::string_view ojp = payload["ojp"].as<const char*>();
    if (ojp.empty() || ojp.size() > kMaxOjpInputBytes) return false;
    request.ojp.assign(ojp);
    return true;
  }
  if (command == UsbCommand::SetBaud) {
    if (payload.size() != 1U || !payload["baud"].is<uint32_t>() ||
        payload["baud"].as<uint32_t>() != 460800U) {
      return false;
    }
    request.baud = 460800U;
    return true;
  }
  if ((payload.size() != 6U && payload.size() != 8U) ||
      !payload["size"].is<uint32_t>() ||
      !payload["sha256"].is<const char*>() ||
      !payload["version"].is<const char*>() ||
      !payload["board"].is<const char*>() ||
      !payload["protocolVersion"].is<uint8_t>() ||
      !payload["official"].is<bool>()) {
    return false;
  }
  FirmwareTransferIntent firmware;
  firmware.size = payload["size"].as<uint32_t>();
  firmware.sha256 = payload["sha256"].as<const char*>();
  firmware.metadata.firmwareVersion = payload["version"].as<const char*>();
  firmware.metadata.board = payload["board"].as<const char*>();
  firmware.metadata.protocolVersion = payload["protocolVersion"].as<uint8_t>();
  firmware.official = payload["official"].as<bool>();
  if (firmware.official) {
    if (payload.size() != 8U || !payload["manifest"].is<const char*>() ||
        !payload["signature"].is<const char*>()) {
      return false;
    }
    firmware.manifest = payload["manifest"].as<const char*>();
    firmware.signature = payload["signature"].as<const char*>();
    if (firmware.manifest.empty() ||
        firmware.manifest.size() > kOtaManifestMaxBytes ||
        firmware.signature.size() != 88U) {
      return false;
    }
  } else if (payload.size() != 6U) {
    return false;
  }
  if (firmware.size == 0U || !validLowerHexSha256(firmware.sha256) ||
      firmware.metadata.board.empty() ||
      firmware.metadata.protocolVersion != 1U ||
      !compareSemanticVersions(firmware.metadata.firmwareVersion,
                               firmware.metadata.firmwareVersion)
           .has_value()) {
    return false;
  }
  request.firmware = std::move(firmware);
  return true;
}

uint16_t readLittleEndian16(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) |
         (static_cast<uint16_t>(data[1]) << 8U);
}

uint32_t readLittleEndian32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) |
         (static_cast<uint32_t>(data[1]) << 8U) |
         (static_cast<uint32_t>(data[2]) << 16U) |
         (static_cast<uint32_t>(data[3]) << 24U);
}

}  // namespace

UsbControlParser::UsbControlParser() { line_.reserve(kUsbControlMaxBytes); }

UsbParseStatus UsbControlParser::consume(char byte) {
  if (status_ == UsbParseStatus::Error) return status_;
  if (status_ == UsbParseStatus::Complete) {
    fail(UsbControlError::ResetRequired);
    return status_;
  }
  if (byte == '\0') {
    fail(UsbControlError::NulByte);
    return status_;
  }
  if (bytesReceived_ == kUsbControlMaxBytes) {
    fail(UsbControlError::TooLarge);
    return status_;
  }
  ++bytesReceived_;
  if (byte == '\n') {
    finishLine();
    return status_;
  }
  line_.push_back(byte);
  return status_;
}

void UsbControlParser::reset() {
  line_.clear();
  request_ = {};
  status_ = UsbParseStatus::NeedMore;
  error_ = UsbControlError::None;
  bytesReceived_ = 0;
}

void UsbControlParser::fail(UsbControlError error) {
  status_ = UsbParseStatus::Error;
  error_ = error;
}

void UsbControlParser::finishLine() {
  if (!line_.empty() && line_.back() == '\r') line_.pop_back();
  if (line_.size() < kControlPrefix.size() ||
      std::string_view(line_).substr(0, kControlPrefix.size()) !=
          kControlPrefix) {
    fail(UsbControlError::InvalidPrefix);
    return;
  }
  const std::string_view json(line_.data() + kControlPrefix.size(),
                              line_.size() - kControlPrefix.size());
  if (!validUtf8(json)) {
    fail(UsbControlError::InvalidUtf8);
    return;
  }
  ArduinoJson::JsonDocument document;
  const auto parseError = ArduinoJson::deserializeJson(
      document, json.data(), json.size(),
      ArduinoJson::DeserializationOption::NestingLimit(2));
  if (parseError || !document.is<ArduinoJson::JsonObjectConst>()) {
    fail(UsbControlError::InvalidJson);
    return;
  }
  if (!hasUniqueObjectKeys(json)) {
    fail(UsbControlError::InvalidContract);
    return;
  }
  const auto object = document.as<ArduinoJson::JsonObjectConst>();
  if (object.size() != 4U || !object["v"].is<uint8_t>() ||
      object["v"].as<uint8_t>() != 1U || !object["id"].is<const char*>() ||
      !object["command"].is<const char*>() ||
      !object["payload"].is<ArduinoJson::JsonObjectConst>()) {
    fail(UsbControlError::InvalidContract);
    return;
  }
  const std::string_view id = object["id"].as<const char*>();
  if (!validRequestId(id)) {
    fail(UsbControlError::InvalidId);
    return;
  }
  const std::string_view commandText = object["command"].as<const char*>();
  const auto command = parseCommand(commandText);
  if (!command.has_value()) {
    fail(UsbControlError::InvalidContract);
    return;
  }
  UsbControlRequest candidate;
  candidate.id.assign(id);
  candidate.command = *command;
  if (!parsePayload(*command,
                    object["payload"].as<ArduinoJson::JsonObjectConst>(),
                    candidate)) {
    fail(UsbControlError::InvalidContract);
    return;
  }
  request_ = std::move(candidate);
  status_ = UsbParseStatus::Complete;
  error_ = UsbControlError::None;
}

std::string encodeUsbResponse(std::string_view id, std::string_view type,
                              std::string_view code, std::string_view message,
                              ArduinoJson::JsonVariantConst data) {
  std::string output;
  if (!encodeUsbResponse(id, type, code, message, data, output)) return {};
  return output;
}

bool encodeUsbResponse(std::string_view id, std::string_view type,
                       std::string_view code, std::string_view message,
                       ArduinoJson::JsonVariantConst data,
                       std::string& output) {
  ArduinoJson::JsonDocument document;
  document["v"] = 1;
  document["id"] = id;
  document["type"] = type;
  document["code"] = code;
  document["message"] = message;
  document["data"].set(data);
  const size_t framedSize =
      kControlPrefix.size() + ArduinoJson::measureJson(document) + 1U;
  if (framedSize > kUsbControlMaxBytes) {
    output.clear();
    return false;
  }
  std::string json;
  ArduinoJson::serializeJson(document, json);
  output.assign(kControlPrefix);
  output += json;
  output.push_back('\n');
  return true;
}

std::string encodeUsbResponse(std::string_view id, std::string_view type,
                              std::string_view code,
                              std::string_view message) {
  ArduinoJson::JsonDocument data;
  data.to<ArduinoJson::JsonObject>();
  return encodeUsbResponse(id, type, code, message,
                           data.as<ArduinoJson::JsonVariantConst>());
}

bool encodeUsbResponse(std::string_view id, std::string_view type,
                       std::string_view code, std::string_view message,
                       std::string& output) {
  ArduinoJson::JsonDocument data;
  data.to<ArduinoJson::JsonObject>();
  return encodeUsbResponse(id, type, code, message,
                           data.as<ArduinoJson::JsonVariantConst>(), output);
}

void encodeUsbCapabilities(ArduinoJson::JsonObject capabilities,
                           const UsbPublicCapabilities& values) {
  capabilities["status"] = values.status;
  capabilities["doctor"] = values.doctor;
  capabilities["structuredLogs"] = values.structuredLogs;
  capabilities["reboot"] = values.reboot;
  capabilities["physicalFactoryReset"] = values.physicalFactoryReset;
  capabilities["provisioningRecovery"] = values.provisioningRecovery;
  capabilities["firmwareInstall"] = values.firmwareInstall;
  capabilities["negotiatedBaud"] = values.negotiatedBaud;
}

uint32_t usbFirmwareCrc32(const uint8_t* data, size_t size) {
  if (data == nullptr && size != 0U) return 0U;
  uint32_t crc = 0xffffffffU;
  for (size_t index = 0; index < size; ++index) {
    crc ^= data[index];
    for (uint8_t bit = 0; bit < 8U; ++bit) {
      crc = (crc >> 1U) ^
            (0xedb88320U & (0U - static_cast<uint32_t>(crc & 1U)));
    }
  }
  return crc ^ 0xffffffffU;
}

UsbFrameConsumeResult UsbFirmwareFrameParser::consume(const uint8_t* data,
                                                      size_t size) {
  if (error_ != UsbFrameError::None || frame_.has_value()) {
    return {status(), 0U};
  }
  if (data == nullptr && size != 0U) {
    error_ = UsbFrameError::InvalidInput;
    return {status(), 0U};
  }
  size_t cursor = 0;
  while (cursor < size && error_ == UsbFrameError::None) {
    if (headerBytes_ < kUsbFirmwareHeaderBytes) {
      const size_t copied =
          std::min(size - cursor, kUsbFirmwareHeaderBytes - headerBytes_);
      std::copy_n(data + cursor, copied, header_.data() + headerBytes_);
      cursor += copied;
      headerBytes_ += copied;
      if (headerBytes_ != kUsbFirmwareHeaderBytes) continue;
      if (!parseHeader()) break;
    }
    const size_t copied =
        std::min(size - cursor, static_cast<size_t>(payloadLength_) -
                                    payload_.size());
    payload_.insert(payload_.end(), data + cursor, data + cursor + copied);
    cursor += copied;
    if (payload_.size() == payloadLength_) {
      (void)finishFrame();
      break;
    }
  }
  return {status(), cursor};
}

UsbFrameParseStatus UsbFirmwareFrameParser::status() const {
  if (error_ != UsbFrameError::None) return UsbFrameParseStatus::Error;
  if (frame_.has_value()) return UsbFrameParseStatus::Complete;
  return UsbFrameParseStatus::NeedMore;
}

size_t UsbFirmwareFrameParser::expectedBytes() const {
  if (error_ != UsbFrameError::None) return 0U;
  if (frame_.has_value()) return 0U;
  if (headerBytes_ < kUsbFirmwareHeaderBytes) {
    return kUsbFirmwareHeaderBytes - headerBytes_;
  }
  return static_cast<size_t>(payloadLength_) - payload_.size();
}

const UsbFirmwareFrame& UsbFirmwareFrameParser::frame() const {
  static const UsbFirmwareFrame empty;
  return frame_.has_value() ? *frame_ : empty;
}

void UsbFirmwareFrameParser::popFrame() { frame_.reset(); }

void UsbFirmwareFrameParser::reset(uint32_t expectedOffset) {
  clearPartial();
  frame_.reset();
  expectedOffset_ = expectedOffset;
  error_ = UsbFrameError::None;
}

bool UsbFirmwareFrameParser::parseHeader() {
  constexpr std::array<uint8_t, 4> magic{'O', 'J', 'F', 'W'};
  if (!std::equal(magic.begin(), magic.end(), header_.begin())) {
    error_ = UsbFrameError::InvalidMagic;
    return false;
  }
  headerOffset_ = readLittleEndian32(header_.data() + 4U);
  payloadLength_ = readLittleEndian16(header_.data() + 8U);
  headerCrc_ = readLittleEndian32(header_.data() + 10U);
  if (payloadLength_ == 0U || payloadLength_ > kUsbFirmwareChunkBytes) {
    error_ = UsbFrameError::InvalidLength;
    return false;
  }
  if (headerOffset_ != expectedOffset_ ||
      headerOffset_ > std::numeric_limits<uint32_t>::max() - payloadLength_) {
    error_ = UsbFrameError::UnexpectedOffset;
    return false;
  }
  payload_.clear();
  payload_.reserve(payloadLength_);
  return true;
}

bool UsbFirmwareFrameParser::finishFrame() {
  if (usbFirmwareCrc32(payload_.data(), payload_.size()) != headerCrc_) {
    error_ = UsbFrameError::CrcMismatch;
    return false;
  }
  frame_ = UsbFirmwareFrame{headerOffset_, std::move(payload_)};
  expectedOffset_ = headerOffset_ + payloadLength_;
  clearPartial();
  return true;
}

void UsbFirmwareFrameParser::clearPartial() {
  header_.fill(0U);
  headerBytes_ = 0;
  payloadLength_ = 0;
  headerOffset_ = 0;
  headerCrc_ = 0;
  payload_.clear();
}

}  // namespace openjornada
