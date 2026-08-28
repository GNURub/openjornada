#include "openjornada/usb_maintenance.hpp"

#include <algorithm>

namespace openjornada {
namespace {

constexpr uint32_t kFactoryConfirmationHoldMs = 5000;
constexpr uint32_t kFactoryConfirmationTimeoutMs = 30000;

bool modeAllowsRecoveryMutation(UsbTerminalMode mode) {
  return mode == UsbTerminalMode::Ready || mode == UsbTerminalMode::Blocked;
}

void addCapabilities(ArduinoJson::JsonObject capabilities) {
  capabilities["status"] = true;
  capabilities["doctor"] = true;
  capabilities["structuredLogs"] = true;
  capabilities["reboot"] = true;
  capabilities["physicalFactoryReset"] = true;
  capabilities["provisioningRecovery"] = true;
}

}  // namespace

const char* usbTerminalModeValue(UsbTerminalMode mode) {
  switch (mode) {
    case UsbTerminalMode::Booting: return "booting";
    case UsbTerminalMode::Ready: return "ready";
    case UsbTerminalMode::Blocked: return "blocked";
    case UsbTerminalMode::Provisioning: return "provisioning";
    case UsbTerminalMode::Updating: return "updating";
    case UsbTerminalMode::AwaitPhysicalConfirmation:
      return "await_physical_confirmation";
  }
  return "booting";
}

const char* usbLogCodeValue(UsbLogCode code) {
  switch (code) {
    case UsbLogCode::TerminalReady: return "terminal_ready";
    case UsbLogCode::TerminalBlocked: return "terminal_blocked";
    case UsbLogCode::NetworkConnected: return "network_connected";
    case UsbLogCode::NetworkDisconnected: return "network_disconnected";
    case UsbLogCode::PendingActionsChanged: return "pending_actions_changed";
    case UsbLogCode::StorageUnavailable: return "storage_unavailable";
    case UsbLogCode::RfidUnavailable: return "rfid_unavailable";
    case UsbLogCode::PhysicalConfirmationStarted:
      return "physical_confirmation_started";
    case UsbLogCode::PhysicalConfirmationCancelled:
      return "physical_confirmation_cancelled";
    case UsbLogCode::FactoryResetFailed: return "factory_reset_failed";
  }
  return "terminal_blocked";
}

UsbMaintenanceDecision UsbMaintenanceService::tick(
    const UsbMaintenanceContext& context) {
  drainOutput();
  if (rebootPending_) {
    servicePendingReboot(context);
    return {true, false};
  }
  size_t consumed = 0;
  while (consumed < kMaxReadBytesPerTick &&
         txBuffer_.size() - txOffset_ < kUsbControlMaxBytes &&
         transport_.available() > 0) {
    const int value = transport_.read();
    if (value < 0) break;
    ++consumed;
    const UsbParseStatus status = parser_.consume(static_cast<char>(value));
    if (status == UsbParseStatus::Complete) {
      const UsbControlRequest request = parser_.request();
      parser_.reset();
      handleRequest(request, context);
    } else if (status == UsbParseStatus::Error) {
      writeResponse("", "error", "invalid_request",
                    "La solicitud USB no es válida.");
      parser_.reset();
    }
  }

  if (confirmation_.has_value()) handleConfirmation(context);
  drainOutput();
  servicePendingReboot(context);
  const bool executeFactoryReset = factoryResetExecutionRequested_;
  factoryResetExecutionRequested_ = false;
  return {confirmation_.has_value() || rebootPending_, executeFactoryReset};
}

void UsbMaintenanceService::completeFactoryReset(bool success,
                                                 uint32_t nowMs) {
  if (!confirmation_.has_value() || !resetConfirmed_) return;
  if (!success) {
    recordLog(UsbLogCode::FactoryResetFailed, nowMs);
    writeResponse(confirmationRequestId_, "event", "factory_reset_failed",
                  "No se pudieron borrar todos los datos.");
    confirmation_.reset();
    resetConfirmed_ = false;
    confirmationRequestId_.clear();
    return;
  }
  writeResponse(confirmationRequestId_, "result", "factory_reset_complete",
                "Datos borrados. Reiniciando.");
  confirmation_.reset();
  resetConfirmed_ = false;
  confirmationRequestId_.clear();
  scheduleReboot(nowMs);
}

void UsbMaintenanceService::recordLog(UsbLogCode code, uint32_t nowMs) {
  if (logSubscriptionId_.empty()) return;
  ArduinoJson::JsonDocument data;
  data["event"] = usbLogCodeValue(code);
  data["uptimeMs"] = nowMs;
  writeResponse(logSubscriptionId_, "event", usbLogCodeValue(code),
                "Evento de mantenimiento.", data.as<ArduinoJson::JsonVariantConst>());
}

void UsbMaintenanceService::handleRequest(
    const UsbControlRequest& request, const UsbMaintenanceContext& context) {
  const UsbTerminalMode effectiveMode = confirmation_.has_value()
                                            ? UsbTerminalMode::AwaitPhysicalConfirmation
                                            : context.status.mode;
  switch (request.command) {
    case UsbCommand::Hello: {
      ArduinoJson::JsonDocument data;
      data["protocolVersion"] = context.status.protocolVersion;
      data["board"] = context.status.board;
      data["firmwareVersion"] = context.status.firmwareVersion;
      data["mode"] = usbTerminalModeValue(effectiveMode);
      addCapabilities(data["capabilities"].to<ArduinoJson::JsonObject>());
      writeResponse(request.id, "result", "ok", "Terminal disponible.",
                    data.as<ArduinoJson::JsonVariantConst>());
      return;
    }
    case UsbCommand::Status: {
      ArduinoJson::JsonDocument data;
      data["board"] = context.status.board;
      data["firmwareVersion"] = context.status.firmwareVersion;
      data["protocolVersion"] = context.status.protocolVersion;
      data["mode"] = usbTerminalModeValue(effectiveMode);
      data["configured"] = context.status.configured;
      data["wifiConnected"] = context.status.wifiConnected;
      data["pendingCount"] = context.status.pendingCount;
      writeResponse(request.id, "result", "ok", "Estado del terminal.",
                    data.as<ArduinoJson::JsonVariantConst>());
      return;
    }
    case UsbCommand::Doctor: {
      ArduinoJson::JsonDocument data;
      data["storageAvailable"] = context.storageAvailable;
      data["rfidAvailable"] = context.rfidAvailable;
      data["configured"] = context.status.configured;
      addCapabilities(data["capabilities"].to<ArduinoJson::JsonObject>());
      auto errors = data["errorCodes"].to<ArduinoJson::JsonArray>();
      if (!context.status.configured) errors.add("configuration_missing");
      if (!context.storageAvailable) errors.add("storage_unavailable");
      if (!context.rfidAvailable) errors.add("rfid_unavailable");
      writeResponse(request.id, "result", "ok", "Diagnóstico completado.",
                    data.as<ArduinoJson::JsonVariantConst>());
      return;
    }
    case UsbCommand::LogsSubscribe:
      logSubscriptionId_ = request.id;
      writeResponse(request.id, "result", "subscribed",
                    "Suscripción de eventos activa.");
      return;
    case UsbCommand::Cancel:
      if (!confirmation_.has_value()) {
        writeResponse(request.id, "error", "nothing_to_cancel",
                      "No hay una operación cancelable.");
        return;
      }
      if (resetConfirmed_) {
        writeResponse(request.id, "error", "already_confirmed",
                      "La confirmación física ya se ha completado.");
        return;
      }
      (void)confirmation_->cancel();
      finishConfirmation("physical_confirmation_cancelled",
                         "Confirmación física cancelada.", context, true);
      writeResponse(request.id, "result", "cancelled",
                    "Operación cancelada.");
      return;
    case UsbCommand::Reboot:
      if (!modeAllowsRecoveryMutation(effectiveMode)) {
        writeResponse(request.id, "error", "mode_denied",
                      "El modo actual no permite reiniciar.");
        return;
      }
      writeResponse(request.id, "result", "rebooting",
                    "Reiniciando el terminal.");
      scheduleReboot(context.nowMs);
      return;
    case UsbCommand::FactoryReset:
      if (!modeAllowsRecoveryMutation(effectiveMode)) {
        writeResponse(request.id, "error", "mode_denied",
                      "El modo actual no permite borrar el terminal.");
        return;
      }
      beginFactoryReset(request, context);
      return;
    case UsbCommand::Provision:
      writeResponse(request.id, "error", "portal_required",
                    "Abre primero el modo de configuración.");
      return;
    case UsbCommand::FirmwareBegin:
    case UsbCommand::FirmwareCommit:
      writeResponse(request.id, "error", "unsupported_operation",
                    "La operación no está disponible.");
      return;
  }
}

void UsbMaintenanceService::handleConfirmation(
    const UsbMaintenanceContext& context) {
  if (!resetConfirmed_) {
    const auto decision = confirmation_->update(context.buttons, context.nowMs);
    switch (decision.state) {
      case ConfirmationState::Waiting:
      case ConfirmationState::Counting: return;
      case ConfirmationState::Cancelled:
        recordLog(UsbLogCode::PhysicalConfirmationCancelled, context.nowMs);
        finishConfirmation("physical_confirmation_cancelled",
                           "Confirmación física cancelada.", context, true);
        return;
      case ConfirmationState::TimedOut:
        finishConfirmation("physical_confirmation_timeout",
                           "La confirmación física ha caducado.", context,
                           true);
        return;
      case ConfirmationState::Confirmed:
        resetConfirmed_ = true;
        break;
    }
  }

  // Confirmation stops the application loop, so no new work is enqueued.
  // Existing bounded worker jobs finish on their own while USB remains live.
  if (!context.runtimeIdle) return;
  factoryResetExecutionRequested_ = true;
}

void UsbMaintenanceService::beginFactoryReset(
    const UsbControlRequest& request, const UsbMaintenanceContext& context) {
  confirmation_.emplace(kFactoryConfirmationHoldMs,
                        kFactoryConfirmationTimeoutMs);
  resetConfirmed_ = false;
  confirmationRequestId_ = request.id;
  (void)confirmation_->update(context.buttons, context.nowMs);
  if (context.showFactoryResetWarning) {
    context.showFactoryResetWarning(context.status.pendingCount);
  }
  ArduinoJson::JsonDocument data;
  data["pendingCount"] = context.status.pendingCount;
  writeResponse(request.id, "result", "physical_confirmation_required",
                "Suelta los botones y mantén SOLO C durante 5 segundos.",
                data.as<ArduinoJson::JsonVariantConst>());
  recordLog(UsbLogCode::PhysicalConfirmationStarted, context.nowMs);
}

void UsbMaintenanceService::finishConfirmation(
    std::string_view code, std::string_view message,
    const UsbMaintenanceContext& context, bool restoreScreen) {
  writeResponse(confirmationRequestId_, "event", code, message);
  confirmation_.reset();
  resetConfirmed_ = false;
  factoryResetExecutionRequested_ = false;
  confirmationRequestId_.clear();
  if (restoreScreen && context.restoreScreen) context.restoreScreen();
}

void UsbMaintenanceService::writeResponse(
    std::string_view id, std::string_view type, std::string_view code,
    std::string_view message) {
  writeLine(encodeUsbResponse(id, type, code, message));
}

void UsbMaintenanceService::writeResponse(
    std::string_view id, std::string_view type, std::string_view code,
    std::string_view message, ArduinoJson::JsonVariantConst data) {
  writeLine(encodeUsbResponse(id, type, code, message, data));
}

void UsbMaintenanceService::writeLine(const std::string& line) {
  if (line.empty()) return;
  if (txOffset_ == txBuffer_.size()) {
    txBuffer_.clear();
    txOffset_ = 0;
  }
  if (line.size() > kMaxQueuedTxBytes - (txBuffer_.size() - txOffset_)) return;
  if (txOffset_ != 0) {
    txBuffer_.erase(0, txOffset_);
    txOffset_ = 0;
  }
  txBuffer_.append(line);
}

void UsbMaintenanceService::drainOutput() {
  if (txOffset_ == txBuffer_.size()) return;
  const size_t available = transport_.availableForWrite();
  if (available == 0) return;
  const size_t remaining = txBuffer_.size() - txOffset_;
  const size_t requested = std::min(available, remaining);
  const size_t written = transport_.write(
      reinterpret_cast<const uint8_t*>(txBuffer_.data() + txOffset_),
      requested);
  if (written == 0 || written > requested) return;
  txOffset_ += written;
  if (txOffset_ == txBuffer_.size()) {
    txBuffer_.clear();
    txOffset_ = 0;
  }
}

void UsbMaintenanceService::scheduleReboot(uint32_t nowMs) {
  rebootPending_ = true;
  rebootRequestedAtMs_ = nowMs;
}

void UsbMaintenanceService::servicePendingReboot(
    const UsbMaintenanceContext& context) {
  if (!rebootPending_) return;
  drainOutput();
  const uint32_t elapsed = context.nowMs - rebootRequestedAtMs_;
  const bool outputQueued = txOffset_ != txBuffer_.size();
  if (outputQueued && elapsed < kRebootFlushBudgetMs) return;
  const uint32_t remaining = elapsed < kRebootFlushBudgetMs
                                 ? kRebootFlushBudgetMs - elapsed
                                 : 0;
  (void)transport_.flush(remaining);
  rebootPending_ = false;
  if (context.reboot) context.reboot();
}

}  // namespace openjornada
