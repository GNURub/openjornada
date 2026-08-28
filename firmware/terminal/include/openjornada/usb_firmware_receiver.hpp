#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <memory>
#include <string>

#include "openjornada/ota.hpp"
#include "openjornada/usb_protocol.hpp"

namespace openjornada {

inline constexpr uint32_t kUsbFirmwareProgressTimeoutMs = 5000U;
inline constexpr uint8_t kUsbFirmwareMaxFrameRetries = 3U;

enum class UsbFirmwareDecision {
  Accept,
  RequirePhysicalConfirmation,
  RejectPendingActions,
  RejectBusy,
  RejectBoard,
  RejectProtocol,
  RejectSignature,
  RejectSize,
  RejectFlash,
  RejectDuplicate,
};

struct UsbFirmwareContext {
  size_t pendingCount = 0;
  uint32_t imageSize = 0;
  uint32_t slotSize = 0;
  bool official = false;
  bool signatureValid = false;
  bool boardCompatible = false;
  bool protocolCompatible = false;
  bool runtimeIdle = false;
  bool physicallyConfirmed = false;
  bool transferActive = false;
};

UsbFirmwareDecision decideUsbFirmwareInstall(
    const UsbFirmwareContext& context);
const char* usbFirmwareDecisionCode(UsbFirmwareDecision decision);
bool officialUsbFirmwareIntentValid(
    const FirmwareTransferIntent& intent, std::string_view currentVersion,
    const std::array<uint8_t, 32>& publicKey);

class FirmwareSlotWriter {
 public:
  virtual ~FirmwareSlotWriter() = default;
  virtual uint32_t capacity() const = 0;
  virtual bool begin(uint32_t size) = 0;
  virtual size_t write(const uint8_t* data, size_t size) = 0;
  virtual bool finish() = 0;
  // Must also restore the running boot partition if finish() already selected
  // the candidate and later commit-state persistence fails.
  virtual void abort() = 0;
};

// Persist the candidate before selecting its partition, then record that the
// bootloader may enter it. On every failure this aborts/restores the writer and
// clears the incomplete persisted transaction.
FirmwareUpdateError finalizeOtaCandidate(
    FirmwareSlotWriter& writer, OtaCommitStore& store,
    const std::string& version, const std::string& hash,
    int64_t checkedAtEpochSeconds);

class UsbFirmwareReceiver {
 public:
  UsbFirmwareReceiver(FirmwareSlotWriter& writer, OtaCommitStore& stateStore);
  ~UsbFirmwareReceiver();

  UsbFirmwareReceiver(const UsbFirmwareReceiver&) = delete;
  UsbFirmwareReceiver& operator=(const UsbFirmwareReceiver&) = delete;

  UsbFirmwareDecision begin(const FirmwareTransferIntent& intent,
                            UsbFirmwareContext context, uint32_t nowMs);
  bool writeFrame(const UsbFirmwareFrame& frame, uint32_t nowMs);
  // CRC failures are retriable without advancing or writing. Other parser
  // failures abort immediately. Returns true while the host may retry.
  bool rejectFrame(UsbFrameError error, uint32_t nowMs);
  // Returns false if the five-second no-progress deadline aborted the transfer.
  bool tick(uint32_t nowMs);
  FirmwareUpdateError commit(int64_t checkedAtEpochSeconds);
  void abort(FirmwareUpdateError error = FirmwareUpdateError::Download);

  bool active() const { return active_; }
  uint32_t expectedOffset() const { return expectedOffset_; }
  uint32_t totalSize() const { return intent_.size; }
  uint32_t slotCapacity() const { return writer_.capacity(); }
  FirmwareUpdateError error() const { return error_; }

 private:
  class HashState;

  void scanFirmwareMetadata(const uint8_t* data, size_t size);
  bool embeddedMetadataMatchesIntent() const;

  FirmwareSlotWriter& writer_;
  OtaCommitStore& stateStore_;
  std::unique_ptr<HashState> hash_;
  FirmwareTransferIntent intent_;
  std::array<uint8_t, 13> metadataWindow_{};
  std::array<uint8_t, 13 + kFirmwareMetadataJsonMaxBytes> metadataBytes_{};
  size_t metadataWindowLength_ = 0;
  size_t metadataLength_ = 0;
  uint8_t metadataMarkers_ = 0;
  bool capturingMetadata_ = false;
  uint32_t expectedOffset_ = 0;
  uint32_t lastProgressAtMs_ = 0;
  uint8_t frameRetries_ = 0;
  FirmwareUpdateError error_ = FirmwareUpdateError::None;
  bool active_ = false;
  bool writerStarted_ = false;
};

#ifdef ARDUINO
class UpdateFirmwareSlotWriter final : public FirmwareSlotWriter {
 public:
  uint32_t capacity() const override;
  bool begin(uint32_t size) override;
  size_t write(const uint8_t* data, size_t size) override;
  bool finish() override;
  void abort() override;

 private:
  const void* runningPartition_ = nullptr;
  bool selectedCandidate_ = false;
};
#endif

}  // namespace openjornada
