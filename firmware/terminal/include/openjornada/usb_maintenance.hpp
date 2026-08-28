#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "openjornada/gesture.hpp"
#include "openjornada/usb_protocol.hpp"
#include "openjornada/usb_firmware_receiver.hpp"

namespace openjornada {

enum class UsbTerminalMode {
  Booting,
  Ready,
  Blocked,
  Provisioning,
  Updating,
  AwaitPhysicalConfirmation,
};

struct UsbPublicStatus {
  std::string board;
  std::string firmwareVersion;
  uint8_t protocolVersion = 1;
  UsbTerminalMode mode = UsbTerminalMode::Booting;
  bool configured = false;
  bool wifiConnected = false;
  size_t pendingCount = 0;
};

// Logs are deliberately a closed vocabulary. Callers cannot attach arbitrary
// text, identifiers, addresses or credentials to an event.
enum class UsbLogCode {
  TerminalReady,
  TerminalBlocked,
  NetworkConnected,
  NetworkDisconnected,
  PendingActionsChanged,
  StorageUnavailable,
  RfidUnavailable,
  PhysicalConfirmationStarted,
  PhysicalConfirmationCancelled,
  FactoryResetFailed,
};

class UsbMaintenanceTransport {
 public:
  virtual ~UsbMaintenanceTransport() = default;
  virtual int available() = 0;
  virtual int read() = 0;
  virtual size_t availableForWrite() = 0;
  virtual size_t write(const uint8_t* data, size_t size) = 0;
  // Implementations must return after at most maxWaitMs even if bytes remain.
  virtual bool flush(uint32_t maxWaitMs) = 0;
  virtual bool setBaud(uint32_t baud) = 0;
};

struct UsbMaintenanceContext {
  UsbPublicStatus status;
  BootButtons buttons;
  uint32_t nowMs = 0;
  bool storageAvailable = false;
  bool rfidAvailable = false;
  bool runtimeIdle = true;
  bool applicationIdle = true;
  int64_t nowEpochSeconds = 0;
  std::array<uint8_t, 32> firmwarePublicKey{};
  std::function<void(size_t)> showFactoryResetWarning;
  std::function<void()> showFirmwareWarning;
  std::function<void(uint32_t, uint32_t)> showFirmwareProgress;
  std::function<void()> restoreScreen;
  std::function<void()> reboot;
};

struct UsbMaintenanceDecision {
  bool suppressAttendanceInput = false;
  bool performFactoryReset = false;
};

class UsbMaintenanceService {
 public:
  explicit UsbMaintenanceService(UsbMaintenanceTransport& transport,
                                 UsbFirmwareReceiver* firmwareReceiver = nullptr)
      : transport_(transport), firmwareReceiver_(firmwareReceiver) {}

  UsbMaintenanceDecision tick(const UsbMaintenanceContext& context);
  void completeFactoryReset(bool success, uint32_t nowMs);
  void recordLog(UsbLogCode code, uint32_t nowMs);
  bool awaitingPhysicalConfirmation() const {
    return confirmation_.has_value();
  }
  bool factoryResetConfirmed() const { return resetConfirmed_; }
  bool firmwareActive() const;

 private:
  static constexpr size_t kMaxReadBytesPerTick = 512;
  static constexpr size_t kMaxQueuedTxBytes = 8192;
  static constexpr uint32_t kRebootFlushBudgetMs = 250;

  void handleRequest(const UsbControlRequest& request,
                     const UsbMaintenanceContext& context);
  void handleConfirmation(const UsbMaintenanceContext& context);
  void beginFactoryReset(const UsbControlRequest& request,
                         const UsbMaintenanceContext& context);
  void beginFirmware(const UsbControlRequest& request,
                     const UsbMaintenanceContext& context,
                     bool physicallyConfirmed = false);
  void startFirmwareTransfer(const FirmwareTransferIntent& intent,
                             std::string_view requestId,
                             const UsbMaintenanceContext& context,
                             bool physicallyConfirmed);
  void serviceFirmwareInput(const UsbMaintenanceContext& context,
                            size_t& consumed);
  void serviceBaudNegotiation(const UsbMaintenanceContext& context);
  void failFirmware(std::string_view code, std::string_view message,
                    const UsbMaintenanceContext& context,
                    bool receiverAlreadyAborted = false);
  void finishConfirmation(std::string_view code, std::string_view message,
                          const UsbMaintenanceContext& context,
                          bool restoreScreen);
  void writeResponse(std::string_view id, std::string_view type,
                     std::string_view code, std::string_view message);
  void writeResponse(std::string_view id, std::string_view type,
                     std::string_view code, std::string_view message,
                     ArduinoJson::JsonVariantConst data);
  void writeLine(const std::string& line);
  void drainOutput();
  void scheduleReboot(uint32_t nowMs);
  void servicePendingReboot(const UsbMaintenanceContext& context);

  UsbMaintenanceTransport& transport_;
  UsbFirmwareReceiver* firmwareReceiver_ = nullptr;
  UsbControlParser parser_;
  UsbFirmwareFrameParser frameParser_;
  // At a binary-frame boundary, OJFW... is a frame and OJUSB/1... may only be
  // an explicit cancel request. The short probe removes any ambiguity.
  std::string firmwareBoundaryProbe_;
  bool firmwareControlLine_ = false;
  std::optional<MaintenanceConfirmationGesture> confirmation_;
  std::string confirmationRequestId_;
  FirmwareTransferIntent confirmationFirmware_;
  std::string logSubscriptionId_;
  std::string txBuffer_;
  size_t txOffset_ = 0;
  bool resetConfirmed_ = false;
  bool firmwareConfirmation_ = false;
  bool factoryResetExecutionRequested_ = false;
  bool rebootPending_ = false;
  uint32_t rebootRequestedAtMs_ = 0;
  enum class FirmwareState {
    Idle,
    AwaitSetBaud,
    FlushBaudAck,
    WaitBaudSwitch,
    AwaitBaudReady,
    Receiving,
    AwaitCommit,
  };
  FirmwareState firmwareState_ = FirmwareState::Idle;
  std::string firmwareRequestId_;
  uint32_t baudStateAtMs_ = 0;
  bool highBaud_ = false;
};

const char* usbTerminalModeValue(UsbTerminalMode mode);
const char* usbLogCodeValue(UsbLogCode code);

}  // namespace openjornada
