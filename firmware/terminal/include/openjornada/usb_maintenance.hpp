#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "openjornada/gesture.hpp"
#include "openjornada/usb_protocol.hpp"

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
};

struct UsbMaintenanceContext {
  UsbPublicStatus status;
  BootButtons buttons;
  uint32_t nowMs = 0;
  bool storageAvailable = false;
  bool rfidAvailable = false;
  bool runtimeIdle = true;
  std::function<void(size_t)> showFactoryResetWarning;
  std::function<void()> restoreScreen;
  std::function<void()> reboot;
};

struct UsbMaintenanceDecision {
  bool suppressAttendanceInput = false;
  bool performFactoryReset = false;
};

class UsbMaintenanceService {
 public:
  explicit UsbMaintenanceService(UsbMaintenanceTransport& transport)
      : transport_(transport) {}

  UsbMaintenanceDecision tick(const UsbMaintenanceContext& context);
  void completeFactoryReset(bool success, uint32_t nowMs);
  void recordLog(UsbLogCode code, uint32_t nowMs);
  bool awaitingPhysicalConfirmation() const {
    return confirmation_.has_value();
  }
  bool factoryResetConfirmed() const { return resetConfirmed_; }

 private:
  static constexpr size_t kMaxReadBytesPerTick = 512;
  static constexpr size_t kMaxQueuedTxBytes = 8192;
  static constexpr uint32_t kRebootFlushBudgetMs = 250;

  void handleRequest(const UsbControlRequest& request,
                     const UsbMaintenanceContext& context);
  void handleConfirmation(const UsbMaintenanceContext& context);
  void beginFactoryReset(const UsbControlRequest& request,
                         const UsbMaintenanceContext& context);
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
  UsbControlParser parser_;
  std::optional<MaintenanceConfirmationGesture> confirmation_;
  std::string confirmationRequestId_;
  std::string logSubscriptionId_;
  std::string txBuffer_;
  size_t txOffset_ = 0;
  bool resetConfirmed_ = false;
  bool factoryResetExecutionRequested_ = false;
  bool rebootPending_ = false;
  uint32_t rebootRequestedAtMs_ = 0;
};

const char* usbTerminalModeValue(UsbTerminalMode mode);
const char* usbLogCodeValue(UsbLogCode code);

}  // namespace openjornada
