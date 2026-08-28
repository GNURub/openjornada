#pragma once

#include <ArduinoJson.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "openjornada/firmware_metadata.hpp"

namespace openjornada {

inline constexpr size_t kUsbControlMaxBytes = 4096;
inline constexpr size_t kUsbFirmwareHeaderBytes = 14;
inline constexpr size_t kUsbFirmwareChunkBytes = 2048;

enum class UsbCommand {
  Hello,
  Status,
  Doctor,
  LogsSubscribe,
  Provision,
  Reboot,
  FactoryReset,
  FirmwareBegin,
  FirmwareCommit,
  Cancel,
};

struct FirmwareTransferIntent {
  uint32_t size = 0;
  std::string sha256;
  FirmwareBuildMetadata metadata;
  bool official = false;
};

struct UsbControlRequest {
  std::string id;
  UsbCommand command = UsbCommand::Hello;
  std::string ojp;
  FirmwareTransferIntent firmware;
};

enum class UsbParseStatus { NeedMore, Complete, Error };

enum class UsbControlError {
  None,
  TooLarge,
  NulByte,
  InvalidPrefix,
  InvalidUtf8,
  InvalidJson,
  InvalidId,
  InvalidContract,
  ResetRequired,
};

class UsbControlParser {
 public:
  UsbControlParser();

  UsbParseStatus consume(char byte);
  UsbParseStatus status() const { return status_; }
  UsbControlError error() const { return error_; }
  const UsbControlRequest& request() const { return request_; }
  size_t bytesReceived() const { return bytesReceived_; }
  void reset();

 private:
  void fail(UsbControlError error);
  void finishLine();

  std::string line_;
  UsbControlRequest request_;
  UsbParseStatus status_ = UsbParseStatus::NeedMore;
  UsbControlError error_ = UsbControlError::None;
  size_t bytesReceived_ = 0;
};

std::string encodeUsbResponse(std::string_view id, std::string_view type,
                              std::string_view code, std::string_view message,
                              ArduinoJson::JsonVariantConst data);
std::string encodeUsbResponse(std::string_view id, std::string_view type,
                              std::string_view code,
                              std::string_view message);
bool encodeUsbResponse(std::string_view id, std::string_view type,
                       std::string_view code, std::string_view message,
                       ArduinoJson::JsonVariantConst data, std::string& output);
bool encodeUsbResponse(std::string_view id, std::string_view type,
                       std::string_view code, std::string_view message,
                       std::string& output);

struct UsbFirmwareFrame {
  uint32_t offset = 0;
  std::vector<uint8_t> payload;
};

enum class UsbFrameParseStatus { NeedMore, Complete, Error };

struct UsbFrameConsumeResult {
  UsbFrameParseStatus status = UsbFrameParseStatus::NeedMore;
  size_t consumed = 0;
};

enum class UsbFrameError {
  None,
  InvalidInput,
  InvalidMagic,
  InvalidLength,
  UnexpectedOffset,
  CrcMismatch,
};

class UsbFirmwareFrameParser {
 public:
  UsbFrameConsumeResult consume(const uint8_t* data, size_t size);
  UsbFrameParseStatus status() const;
  UsbFrameError error() const { return error_; }
  size_t expectedBytes() const;
  size_t frameCount() const { return frame_.has_value() ? 1U : 0U; }
  const UsbFirmwareFrame& frame() const;
  void popFrame();
  uint32_t expectedOffset() const { return expectedOffset_; }
  void reset(uint32_t expectedOffset = 0);

 private:
  bool parseHeader();
  bool finishFrame();
  void clearPartial();

  std::array<uint8_t, kUsbFirmwareHeaderBytes> header_{};
  size_t headerBytes_ = 0;
  uint16_t payloadLength_ = 0;
  uint32_t headerOffset_ = 0;
  uint32_t headerCrc_ = 0;
  std::vector<uint8_t> payload_;
  std::optional<UsbFirmwareFrame> frame_;
  uint32_t expectedOffset_ = 0;
  UsbFrameError error_ = UsbFrameError::None;
};

uint32_t usbFirmwareCrc32(const uint8_t* data, size_t size);

}  // namespace openjornada
