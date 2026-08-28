#include "openjornada/usb_maintenance.hpp"

#include <algorithm>

namespace openjornada {
namespace {

constexpr uint32_t kFactoryConfirmationHoldMs = 5000;
constexpr uint32_t kFactoryConfirmationTimeoutMs = 30000;
constexpr uint32_t kFirmwareBaud = 460800U;
constexpr uint32_t kDefaultBaud = 115200U;
constexpr uint32_t kBaudSettleMs = 100U;
constexpr uint32_t kBaudReadyTimeoutMs = 2000U;
constexpr std::string_view kUsbControlPrefix = "OJUSB/1 ";

bool modeAllowsRecoveryMutation(UsbTerminalMode mode) {
  return mode == UsbTerminalMode::Ready || mode == UsbTerminalMode::Blocked;
}

void addCapabilities(ArduinoJson::JsonObject capabilities,
                     bool firmwareAvailable) {
  capabilities["status"] = true;
  capabilities["doctor"] = true;
  capabilities["structuredLogs"] = true;
  capabilities["reboot"] = true;
  capabilities["physicalFactoryReset"] = true;
  capabilities["provisioningRecovery"] = true;
  capabilities["firmwareInstall"] = firmwareAvailable;
  capabilities["negotiatedBaud"] = firmwareAvailable;
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
  serviceBaudNegotiation(context);
  if (firmwareReceiver_ != nullptr && firmwareReceiver_->active() &&
      !firmwareReceiver_->tick(context.nowMs)) {
    failFirmware("firmware_timeout",
                 "La transferencia de firmware ha caducado.", context, true);
  }
  size_t consumed = 0;
  if (firmwareState_ == FirmwareState::Receiving) {
    serviceFirmwareInput(context, consumed);
  }
  while (consumed < kMaxReadBytesPerTick &&
         firmwareState_ != FirmwareState::Receiving &&
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
  serviceBaudNegotiation(context);
  drainOutput();
  servicePendingReboot(context);
  const bool executeFactoryReset = factoryResetExecutionRequested_;
  factoryResetExecutionRequested_ = false;
  return {confirmation_.has_value() || rebootPending_ || firmwareActive(),
          executeFactoryReset};
}

bool UsbMaintenanceService::firmwareActive() const {
  return firmwareState_ != FirmwareState::Idle ||
         (firmwareReceiver_ != nullptr && firmwareReceiver_->active()) ||
         firmwareConfirmation_;
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
                                        : (firmwareActive() || rebootPending_)
                                            ? UsbTerminalMode::Updating
                                            : context.status.mode;
  switch (request.command) {
    case UsbCommand::Hello: {
      ArduinoJson::JsonDocument data;
      data["protocolVersion"] = context.status.protocolVersion;
      data["board"] = context.status.board;
      data["firmwareVersion"] = context.status.firmwareVersion;
      data["mode"] = usbTerminalModeValue(effectiveMode);
      addCapabilities(data["capabilities"].to<ArduinoJson::JsonObject>(),
                      firmwareReceiver_ != nullptr);
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
      addCapabilities(data["capabilities"].to<ArduinoJson::JsonObject>(),
                      firmwareReceiver_ != nullptr);
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
        if (firmwareActive()) {
          if (firmwareReceiver_ != nullptr && firmwareReceiver_->active()) {
            firmwareReceiver_->abort();
          }
          failFirmware("firmware_cancelled",
                       "Transferencia de firmware cancelada.", context, true);
          writeResponse(request.id, "result", "cancelled",
                        "Operación cancelada.");
          return;
        }
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
      beginFirmware(request, context);
      return;
    case UsbCommand::FirmwareCommit:
      if (firmwareReceiver_ == nullptr ||
          firmwareState_ != FirmwareState::AwaitCommit ||
          !firmwareReceiver_->active()) {
        writeResponse(request.id, "error", "firmware_not_ready",
                      "La transferencia no está lista para confirmar.");
        return;
      }
      if (const FirmwareUpdateError commit =
              firmwareReceiver_->commit(context.nowEpochSeconds);
          commit != FirmwareUpdateError::None) {
        failFirmware(firmwareUpdateErrorValue(commit),
                     "No se pudo preparar el firmware.", context, true);
        return;
      }
      writeResponse(request.id, "result", "rebooting",
                    "Firmware verificado. Reiniciando.");
      firmwareState_ = FirmwareState::Idle;
      firmwareRequestId_.clear();
      scheduleReboot(context.nowMs);
      return;
    case UsbCommand::SetBaud:
      if (firmwareState_ != FirmwareState::AwaitSetBaud) {
        writeResponse(request.id, "error", "firmware_not_ready",
                      "No hay una transferencia esperando velocidad.");
        return;
      }
      {
        ArduinoJson::JsonDocument data;
        data["baud"] = kFirmwareBaud;
        writeResponse(request.id, "result", "baud_accepted",
                      "Velocidad de transferencia aceptada.",
                      data.as<ArduinoJson::JsonVariantConst>());
      }
      firmwareState_ = FirmwareState::FlushBaudAck;
      baudStateAtMs_ = context.nowMs;
      return;
    case UsbCommand::BaudReady:
      if (firmwareState_ != FirmwareState::AwaitBaudReady) {
        writeResponse(request.id, "error", "baud_not_expected",
                      "No se esperaba confirmación de velocidad.");
        return;
      }
      writeResponse(request.id, "result", "baud_ready",
                    "Velocidad de transferencia preparada.");
      firmwareState_ = FirmwareState::Receiving;
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

  if (firmwareConfirmation_) {
    if (!context.runtimeIdle) return;
    const FirmwareTransferIntent intent = confirmationFirmware_;
    const std::string requestId = confirmationRequestId_;
    confirmation_.reset();
    resetConfirmed_ = false;
    firmwareConfirmation_ = false;
    confirmationFirmware_ = {};
    confirmationRequestId_.clear();
    startFirmwareTransfer(intent, requestId, context, true);
    return;
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
  firmwareConfirmation_ = false;
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

void UsbMaintenanceService::beginFirmware(
    const UsbControlRequest& request, const UsbMaintenanceContext& context,
    bool physicallyConfirmed) {
  if (firmwareReceiver_ == nullptr) {
    writeResponse(request.id, "error", "unsupported_operation",
                  "La operación no está disponible.");
    return;
  }
  if (firmwareActive() || confirmation_.has_value()) {
    writeResponse(request.id, "error", "duplicate_begin",
                  "Ya hay una operación de firmware activa.");
    return;
  }
  UsbFirmwareContext policy;
  policy.pendingCount = context.status.pendingCount;
  policy.imageSize = request.firmware.size;
  policy.slotSize = firmwareReceiver_->slotCapacity();
  policy.official = request.firmware.official;
  policy.signatureValid = officialUsbFirmwareIntentValid(
      request.firmware, context.status.firmwareVersion,
      context.firmwarePublicKey);
  policy.boardCompatible =
      request.firmware.metadata.board == context.status.board;
  policy.protocolCompatible = request.firmware.metadata.protocolVersion ==
                              context.status.protocolVersion;
  policy.runtimeIdle = context.runtimeIdle && context.applicationIdle;
  policy.physicallyConfirmed = physicallyConfirmed;
  const UsbFirmwareDecision decision = decideUsbFirmwareInstall(policy);
  if (decision == UsbFirmwareDecision::RequirePhysicalConfirmation) {
    confirmation_.emplace(kFactoryConfirmationHoldMs,
                          kFactoryConfirmationTimeoutMs);
    firmwareConfirmation_ = true;
    resetConfirmed_ = false;
    confirmationRequestId_ = request.id;
    confirmationFirmware_ = request.firmware;
    (void)confirmation_->update(context.buttons, context.nowMs);
    if (context.showFirmwareWarning) context.showFirmwareWarning();
    writeResponse(request.id, "result", "physical_confirmation_required",
                  "Suelta los botones y mantén SOLO C durante 5 segundos.");
    return;
  }
  if (decision != UsbFirmwareDecision::Accept) {
    writeResponse(request.id, "error", usbFirmwareDecisionCode(decision),
                  "El firmware no cumple la política de instalación.");
    return;
  }
  startFirmwareTransfer(request.firmware, request.id, context,
                        physicallyConfirmed);
}

void UsbMaintenanceService::startFirmwareTransfer(
    const FirmwareTransferIntent& intent, std::string_view requestId,
    const UsbMaintenanceContext& context, bool physicallyConfirmed) {
  UsbFirmwareContext policy;
  policy.pendingCount = context.status.pendingCount;
  policy.imageSize = intent.size;
  policy.slotSize = firmwareReceiver_->slotCapacity();
  policy.official = intent.official;
  policy.signatureValid = officialUsbFirmwareIntentValid(
      intent, context.status.firmwareVersion, context.firmwarePublicKey);
  policy.boardCompatible = intent.metadata.board == context.status.board;
  policy.protocolCompatible =
      intent.metadata.protocolVersion == context.status.protocolVersion;
  policy.runtimeIdle = context.runtimeIdle && context.applicationIdle;
  policy.physicallyConfirmed = physicallyConfirmed;
  const UsbFirmwareDecision decision =
      firmwareReceiver_->begin(intent, policy, context.nowMs);
  if (decision != UsbFirmwareDecision::Accept) {
    writeResponse(requestId, "error", usbFirmwareDecisionCode(decision),
                  "No se pudo iniciar la escritura del firmware.");
    if (context.restoreScreen) context.restoreScreen();
    return;
  }
  firmwareRequestId_.assign(requestId);
  firmwareState_ = FirmwareState::AwaitSetBaud;
  frameParser_.reset();
  firmwareBoundaryProbe_.clear();
  firmwareControlLine_ = false;
  ArduinoJson::JsonDocument data;
  data["baud"] = kFirmwareBaud;
  writeResponse(requestId, "result", "firmware_accepted",
                "Firmware aceptado para transferencia.",
                data.as<ArduinoJson::JsonVariantConst>());
  if (context.showFirmwareProgress) context.showFirmwareProgress(0, intent.size);
}

void UsbMaintenanceService::serviceFirmwareInput(
    const UsbMaintenanceContext& context, size_t& consumed) {
  const auto consumeFrameByte = [&](uint8_t byte) {
    const auto result = frameParser_.consume(&byte, 1);
    if (result.status == UsbFrameParseStatus::Error) {
      const UsbFrameError frameError = frameParser_.error();
      const bool retry =
          firmwareReceiver_->rejectFrame(frameError, context.nowMs);
      frameParser_.reset(firmwareReceiver_->expectedOffset());
      if (retry) {
        ArduinoJson::JsonDocument data;
        data["nextOffset"] = firmwareReceiver_->expectedOffset();
        writeResponse(firmwareRequestId_, "event", "firmware_retry",
                      "Repite el bloque de firmware.",
                      data.as<ArduinoJson::JsonVariantConst>());
      } else {
        failFirmware("firmware_frame_invalid",
                     "El bloque de firmware no es válido.", context, true);
      }
      return;
    }
    if (result.status != UsbFrameParseStatus::Complete) return;
    const UsbFirmwareFrame frame = frameParser_.frame();
    if (!firmwareReceiver_->writeFrame(frame, context.nowMs)) {
      frameParser_.reset();
      failFirmware(firmwareUpdateErrorValue(firmwareReceiver_->error()),
                   "No se pudo escribir el bloque de firmware.", context,
                   true);
      return;
    }
    frameParser_.popFrame();
    ArduinoJson::JsonDocument data;
    data["nextOffset"] = firmwareReceiver_->expectedOffset();
    writeResponse(firmwareRequestId_, "event", "firmware_ack",
                  "Bloque de firmware recibido.",
                  data.as<ArduinoJson::JsonVariantConst>());
    if (context.showFirmwareProgress) {
      context.showFirmwareProgress(firmwareReceiver_->expectedOffset(),
                                   firmwareReceiver_->totalSize());
    }
    if (firmwareReceiver_->expectedOffset() == firmwareReceiver_->totalSize()) {
      firmwareState_ = FirmwareState::AwaitCommit;
    }
  };

  while (consumed < kMaxReadBytesPerTick && transport_.available() > 0 &&
         firmwareState_ == FirmwareState::Receiving) {
    const int value = transport_.read();
    if (value < 0) break;
    const uint8_t byte = static_cast<uint8_t>(value);
    ++consumed;
    if (firmwareControlLine_) {
      const UsbParseStatus status = parser_.consume(static_cast<char>(byte));
      if (status == UsbParseStatus::Complete) {
        const UsbControlRequest request = parser_.request();
        parser_.reset();
        firmwareControlLine_ = false;
        if (request.command == UsbCommand::Cancel) {
          handleRequest(request, context);
        } else {
          failFirmware("firmware_control_invalid",
                       "Sólo se permite cancelar entre bloques.", context);
        }
      } else if (status == UsbParseStatus::Error) {
        parser_.reset();
        firmwareControlLine_ = false;
        failFirmware("firmware_control_invalid",
                     "La cancelación de firmware no es válida.", context);
      }
      continue;
    }

    if (!firmwareBoundaryProbe_.empty() ||
        frameParser_.atFrameBoundary()) {
      firmwareBoundaryProbe_.push_back(static_cast<char>(byte));
      const bool prefixStillPossible =
          firmwareBoundaryProbe_.size() <= kUsbControlPrefix.size() &&
          kUsbControlPrefix.compare(0, firmwareBoundaryProbe_.size(),
                                    firmwareBoundaryProbe_) == 0;
      if (prefixStillPossible) {
        if (firmwareBoundaryProbe_.size() == kUsbControlPrefix.size()) {
          parser_.reset();
          for (const char prefixByte : firmwareBoundaryProbe_) {
            (void)parser_.consume(prefixByte);
          }
          firmwareBoundaryProbe_.clear();
          firmwareControlLine_ = true;
        }
        continue;
      }
      const std::string binaryPrefix = std::move(firmwareBoundaryProbe_);
      firmwareBoundaryProbe_.clear();
      for (const unsigned char prefixByte : binaryPrefix) {
        consumeFrameByte(prefixByte);
        if (firmwareState_ != FirmwareState::Receiving) break;
      }
      continue;
    }
    consumeFrameByte(byte);
  }
}

void UsbMaintenanceService::serviceBaudNegotiation(
    const UsbMaintenanceContext& context) {
  if (firmwareState_ == FirmwareState::FlushBaudAck) {
    drainOutput();
    if (txOffset_ != txBuffer_.size()) return;
    if (!transport_.flush(20U)) return;
    baudStateAtMs_ = context.nowMs;
    firmwareState_ = FirmwareState::WaitBaudSwitch;
    return;
  }
  if (firmwareState_ == FirmwareState::WaitBaudSwitch &&
      static_cast<uint32_t>(context.nowMs - baudStateAtMs_) >= kBaudSettleMs) {
    parser_.reset();
    if (transport_.setBaud(kFirmwareBaud)) {
      highBaud_ = true;
      baudStateAtMs_ = context.nowMs;
      firmwareState_ = FirmwareState::AwaitBaudReady;
    } else {
      (void)transport_.setBaud(kDefaultBaud);
      highBaud_ = false;
      firmwareState_ = FirmwareState::Receiving;
      writeResponse(firmwareRequestId_, "event", "baud_fallback",
                    "Continuando a 115200 baudios.");
    }
    return;
  }
  if (firmwareState_ == FirmwareState::AwaitBaudReady &&
      static_cast<uint32_t>(context.nowMs - baudStateAtMs_) >=
          kBaudReadyTimeoutMs) {
    (void)transport_.setBaud(kDefaultBaud);
    highBaud_ = false;
    parser_.reset();
    firmwareState_ = FirmwareState::Receiving;
    writeResponse(firmwareRequestId_, "event", "baud_fallback",
                  "Continuando a 115200 baudios.");
  }
}

void UsbMaintenanceService::failFirmware(
    std::string_view code, std::string_view message,
    const UsbMaintenanceContext& context, bool receiverAlreadyAborted) {
  if (!receiverAlreadyAborted && firmwareReceiver_ != nullptr &&
      firmwareReceiver_->active()) {
    firmwareReceiver_->abort();
  }
  const std::string requestId = firmwareRequestId_;
  firmwareState_ = FirmwareState::Idle;
  firmwareRequestId_.clear();
  frameParser_.reset();
  firmwareBoundaryProbe_.clear();
  firmwareControlLine_ = false;
  parser_.reset();
  if (highBaud_) {
    (void)transport_.setBaud(kDefaultBaud);
    highBaud_ = false;
  }
  writeResponse(requestId, "event", code, message);
  if (context.restoreScreen) context.restoreScreen();
}

void UsbMaintenanceService::finishConfirmation(
    std::string_view code, std::string_view message,
    const UsbMaintenanceContext& context, bool restoreScreen) {
  writeResponse(confirmationRequestId_, "event", code, message);
  confirmation_.reset();
  resetConfirmed_ = false;
  firmwareConfirmation_ = false;
  confirmationFirmware_ = {};
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
