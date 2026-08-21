#include "openjornada/app_controller.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <ctime>
#include <string_view>
#include <utility>

#include "openjornada/signature.hpp"

namespace openjornada {
namespace {

bool deadlineReached(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

bool ambiguous(const ApiFailure& failure) {
  return failure.retryable || failure.code == ApiErrorCode::Transport ||
         failure.code == ApiErrorCode::Timeout ||
         failure.code == ApiErrorCode::InvalidResponse;
}

const char* actionSuccessMessage(Command command) {
  switch (command) {
    case Command::ClockIn: return "Jornada iniciada";
    case Command::BreakStart: return "Pausa iniciada";
    case Command::BreakEnd: return "Pausa terminada";
    case Command::ClockOut: return "Jornada terminada";
  }
  return "Fichaje registrado";
}

bool decimal(std::string_view value, size_t offset, size_t length,
             int& output) {
  if (offset > value.size() || length > value.size() - offset) return false;
  int parsed = 0;
  for (size_t index = 0; index < length; ++index) {
    const unsigned char byte = value[offset + index];
    if (!std::isdigit(byte)) return false;
    parsed = parsed * 10 + static_cast<int>(byte - '0');
  }
  output = parsed;
  return true;
}

int64_t daysFromCivil(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yearOfEra = static_cast<unsigned>(year - era * 400);
  const unsigned adjustedMonth = static_cast<unsigned>(
      static_cast<int>(month) + (month > 2 ? -3 : 9));
  const unsigned dayOfYear =
      (153U * adjustedMonth + 2U) / 5U +
      day - 1U;
  const unsigned dayOfEra =
      yearOfEra * 365U + yearOfEra / 4U - yearOfEra / 100U + dayOfYear;
  return static_cast<int64_t>(era) * 146097 +
         static_cast<int64_t>(dayOfEra) - 719468;
}

std::optional<int64_t> parseRfc3339(std::string_view value) {
  if (value.size() < 20 || value[4] != '-' || value[7] != '-' ||
      value[10] != 'T' || value[13] != ':' || value[16] != ':') {
    return std::nullopt;
  }
  int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  if (!decimal(value, 0, 4, year) || !decimal(value, 5, 2, month) ||
      !decimal(value, 8, 2, day) || !decimal(value, 11, 2, hour) ||
      !decimal(value, 14, 2, minute) || !decimal(value, 17, 2, second) ||
      month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 ||
      minute > 59 || second > 60) {
    return std::nullopt;
  }
  size_t zone = 19;
  if (zone < value.size() && value[zone] == '.') {
    ++zone;
    const size_t fractionStart = zone;
    while (zone < value.size() && std::isdigit(
                                       static_cast<unsigned char>(value[zone]))) {
      ++zone;
    }
    if (zone == fractionStart) return std::nullopt;
  }
  int offsetSeconds = 0;
  if (zone < value.size() && value[zone] == 'Z') {
    ++zone;
  } else if (zone + 6 == value.size() &&
             (value[zone] == '+' || value[zone] == '-') &&
             value[zone + 3] == ':') {
    int offsetHour = 0, offsetMinute = 0;
    if (!decimal(value, zone + 1, 2, offsetHour) ||
        !decimal(value, zone + 4, 2, offsetMinute) || offsetHour > 23 ||
        offsetMinute > 59) {
      return std::nullopt;
    }
    offsetSeconds = (offsetHour * 60 + offsetMinute) * 60;
    if (value[zone] == '-') offsetSeconds = -offsetSeconds;
    zone += 6;
  } else {
    return std::nullopt;
  }
  if (zone != value.size()) return std::nullopt;
  const int64_t epoch =
      daysFromCivil(year, static_cast<unsigned>(month),
                    static_cast<unsigned>(day)) *
          86400 +
      hour * 3600 + minute * 60 + second - offsetSeconds;
  return epoch;
}

}  // namespace

std::string isoUtc(int64_t epochSeconds) {
  if (epochSeconds <= 0) return {};
  const std::time_t raw = static_cast<std::time_t>(epochSeconds);
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &raw);
#else
  gmtime_r(&raw, &utc);
#endif
  std::array<char, 32> output{};
  if (std::strftime(output.data(), output.size(), "%Y-%m-%dT%H:%M:%SZ",
                    &utc) == 0) {
    return {};
  }
  return output.data();
}

AppController::AppController(NetworkWorker& worker, Outbox& outbox,
                             AppControllerConfig config)
    : worker_(worker), outbox_(outbox), config_(std::move(config)) {}

void AppController::start(size_t pendingCount, uint32_t nowMs) {
  started_ = true;
  screen_ = {};
  screen_.kind = ScreenKind::Boot;
  screen_.title = "OpenJornada";
  screen_.detail = "Conectando con el servidor...";
  screen_.pendingCount = pendingCount;
  bootstrapRetryAtMs_ = nowMs;
}

void AppController::tick(const AppEvent& event) {
  if (!started_) return;
  updateStatus(event);
  processNetworkResults(event);
  switch (event.kind) {
    case AppEventKind::Timer: handleTimer(event); break;
    case AppEventKind::TagScanned: handleTag(event); break;
    case AppEventKind::ButtonPressed: handleButton(event, false); break;
    case AppEventKind::ButtonHeld: handleButton(event, true); break;
  }
}

AppFeedback AppController::takeFeedback() {
  const AppFeedback result = feedback_;
  feedback_ = AppFeedback::None;
  return result;
}

void AppController::updateStatus(const AppEvent& event) {
  screen_.networkConnected = event.networkConnected;
  screen_.ntpTrusted = event.ntpTrusted;
}

void AppController::processNetworkResults(const AppEvent& event) {
  NetworkResult result;
  while (worker_.poll(result)) {
    processNetworkResult(std::move(result), event);
    result = {};
  }
}

void AppController::processNetworkResult(NetworkResult&& result,
                                         const AppEvent& event) {
  if (result.id != activeJobId_) return;
  activeJobId_ = 0;
  if (result.kind == NetworkJobKind::Bootstrap) {
    bootstrapQueued_ = false;
    if (!result.call.ok || result.bootstrap == nullptr) {
      const std::string message = result.call.failure.safeMessage.empty()
                                      ? "No se pudo conectar con OpenJornada."
                                      : result.call.failure.safeMessage;
      showMessage(message, event.nowMs, kMessageMs, true);
      bootstrapRetryAtMs_ = event.nowMs +
                            std::max<uint32_t>(result.suggestedRetryMs, 2000U);
      return;
    }
    terminalId_ = result.bootstrap->terminal.id;
    timezone_ = result.bootstrap->timezone;
    clockSyncedAt_ = result.bootstrap->serverTime;
    bootstrapReady_ = true;
    screen_.ntpTrusted = true;
    returnToIdle();
    return;
  }
  if (result.kind == NetworkJobKind::Resolve) {
    const bool closeAfterRefresh = resolveForClockOut_;
    resolveForClockOut_ = false;
    const std::string expectedEmployeeId =
        std::move(closeExpectedEmployeeId_);
    closeExpectedEmployeeId_.clear();
    if (!result.call.ok || result.resolve == nullptr) {
      const std::string message = result.call.failure.safeMessage.empty()
                                      ? "Tag no asignado; avisa a un responsable."
                                      : result.call.failure.safeMessage;
      showMessage(message, event.nowMs, kMessageMs, true);
      feedback_ = AppFeedback::Error;
      return;
    }
    ResolveResponse candidate = std::move(*result.resolve);
    candidate.state.longShift =
        candidate.state.kind == WorkKind::Working &&
        (candidate.state.longShift ||
         candidate.state.workedSeconds >= 4 * 60 * 60);
    candidate.state.staleBreak =
        candidate.state.kind == WorkKind::OnBreak &&
        (candidate.state.staleBreak ||
         candidate.state.breakSeconds > 25 * 60);
    if (closeAfterRefresh) {
      if (expectedEmployeeId.empty() ||
          candidate.employee.id != expectedEmployeeId) {
        showMessage("La tarjeta ahora pertenece a otra persona; acerca de "
                    "nuevo el tag.",
                    event.nowMs, kMessageMs, true);
        feedback_ = AppFeedback::Error;
        return;
      }
      lastAuthoritativeState_ = candidate.state;
      resolved_ = std::move(candidate);
      if (resolved_->state.kind != WorkKind::Working) {
        showMessage("El estado de la jornada ha cambiado; acerca de nuevo el "
                    "tag.",
                    event.nowMs, kMessageMs, true);
        feedback_ = AppFeedback::Error;
        return;
      }
      executeAction(Command::ClockOut, event);
      return;
    }
    lastAuthoritativeState_ = candidate.state;
    resolved_ = std::move(candidate);
    showActions(event.nowMs);
    return;
  }
  if (result.kind == NetworkJobKind::Action) {
    handleActionResult(std::move(result), event);
  }
}

void AppController::handleTimer(const AppEvent& event) {
  if (!bootstrapReady_ && !bootstrapQueued_ && activeJobId_ == 0 &&
      event.networkConnected &&
      (bootstrapRetryAtMs_ == 0 ||
       deadlineReached(event.nowMs, bootstrapRetryAtMs_))) {
    enqueueBootstrap(event.nowMs);
  }
  if (screen_.kind == ScreenKind::Message && messageDeadlineActive_ &&
      deadlineReached(event.nowMs, messageNextAtMs_)) {
    messageDeadlineActive_ = false;
    if (bootstrapReady_) {
      returnToIdle();
    } else {
      screen_.kind = ScreenKind::Boot;
      screen_.title = "OpenJornada";
      screen_.detail = event.networkConnected
                           ? "Reintentando conexión..."
                           : "Esperando conexión Wi-Fi...";
      screen_.deadlineMs = 0;
    }
  }
  if (screen_.kind == ScreenKind::Actions &&
      deadlineReached(event.nowMs, selectedActionDeadlineMs_)) {
    returnToIdle();
  }
  if (interactionDeadlineActive_ &&
      (screen_.kind == ScreenKind::TimePicker ||
       screen_.kind == ScreenKind::CloseConfirm) &&
      deadlineReached(event.nowMs, interactionDeadlineMs_)) {
    returnToIdle();
  }
}

void AppController::handleTag(const AppEvent& event) {
  if (!bootstrapReady_ || !event.networkConnected || activeJobId_ != 0 ||
      screen_.kind != ScreenKind::Idle || event.uid.empty()) {
    return;
  }
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Resolve;
  job.credentials = config_.credentials;
  job.uid = event.uid;
  if (!worker_.enqueue(job)) {
    showMessage("El terminal está ocupado; vuelve a acercar el tag.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }
  activeJobId_ = job.id;
  currentUid_ = event.uid;
  screen_.kind = ScreenKind::Message;
  screen_.title = "Leyendo tarjeta";
  screen_.detail = "Comprobando la jornada...";
  screen_.buttons = {};
  screen_.busy = true;
  screen_.deadlineMs = 0;
}

void AppController::handleButton(const AppEvent& event, bool held) {
  if (screen_.kind == ScreenKind::TimePicker) {
    if (held && event.button != Button::A && event.button != Button::C) return;
    if (!held && event.button == Button::B) {
      executeAction(pickerCommand_, event, screen_.selectedEpochSeconds,
                    pickerClosesBreak_);
      return;
    }
    if (event.button == Button::A || event.button == Button::C) {
      int stepMinutes = held ? 30 : 5;
      if (held && lastPickerPress_.has_value() &&
          *lastPickerPress_ == event.button &&
          event.nowMs - lastPickerPressAtMs_ <= 2000U) {
        // The physical button emits a press before it becomes a hold. Replace
        // that initial 5-minute step so one hold means 30, not 35 minutes.
        stepMinutes -= 5;
      }
      const int64_t requested =
          screen_.selectedEpochSeconds +
          (event.button == Button::A ? -stepMinutes : stepMinutes) * 60;
      screen_.selectedEpochSeconds =
          std::clamp(requested, pickerMinEpochSeconds_,
                     pickerMaxEpochSeconds_);
      if (held) {
        lastPickerPress_.reset();
      } else {
        lastPickerPress_ = event.button;
        lastPickerPressAtMs_ = event.nowMs;
      }
      armInteractionDeadline(event.nowMs);
    }
    return;
  }
  if (held || activeJobId_ != 0) return;
  if (screen_.kind == ScreenKind::CloseConfirm) {
    if (event.button == Button::A) returnToIdle();
    if (event.button == Button::C) {
      enqueueCloseRefresh(event);
    }
    return;
  }
  if (screen_.kind != ScreenKind::Actions || !resolved_.has_value()) return;
  const auto& state = resolved_->state;
  if (state.kind == WorkKind::Idle && event.button == Button::B) {
    executeAction(Command::ClockIn, event);
  } else if (state.kind == WorkKind::Working) {
    if (event.button == Button::A) {
      executeAction(Command::BreakStart, event);
    } else if ((!state.longShift && event.button == Button::C) ||
               (state.longShift && event.button == Button::B)) {
      executeAction(Command::ClockOut, event);
    } else if (state.longShift && event.button == Button::C) {
      openTimePicker(Command::ClockOut, false, event);
    }
  } else if (state.kind == WorkKind::OnBreak) {
    if (event.button == Button::A) {
      executeAction(Command::BreakEnd, event);
    } else if (event.button == Button::C) {
      openTimePicker(Command::BreakEnd, true, event);
    }
  }
}

void AppController::enqueueBootstrap(uint32_t nowMs) {
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Bootstrap;
  job.credentials = config_.credentials;
  job.bootstrap = {kTerminalProtocolVersion, config_.clientVersion,
                   static_cast<uint32_t>(std::min<size_t>(
                       screen_.pendingCount, OutboxCodec::kCapacity))};
  if (!worker_.enqueue(job)) {
    bootstrapRetryAtMs_ = nowMs + 2000U;
    return;
  }
  activeJobId_ = job.id;
  bootstrapQueued_ = true;
  screen_.kind = ScreenKind::Boot;
  screen_.title = "OpenJornada";
  screen_.detail = "Conectando con el servidor...";
  screen_.busy = true;
}

void AppController::enqueueCloseRefresh(const AppEvent& event) {
  interactionDeadlineActive_ = false;
  if (!event.networkConnected || currentUid_.empty() ||
      !resolved_.has_value() || resolved_->employee.id.empty()) {
    showMessage("No se pudo actualizar la jornada; acerca de nuevo el tag.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Resolve;
  job.credentials = config_.credentials;
  job.uid = currentUid_;
  if (!worker_.enqueue(job)) {
    showMessage("El terminal está ocupado; acerca de nuevo el tag.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }
  activeJobId_ = job.id;
  closeExpectedEmployeeId_ = resolved_->employee.id;
  resolveForClockOut_ = true;
  screen_.kind = ScreenKind::Message;
  screen_.title = "Actualizando jornada";
  screen_.detail = "Comprobando el estado antes de cerrar...";
  screen_.buttons = {};
  screen_.busy = true;
  screen_.deadlineMs = 0;
}

void AppController::showActions(uint32_t nowMs) {
  screen_.kind = ScreenKind::Actions;
  screen_.title = resolved_->employee.displayName;
  screen_.employee = resolved_->employee.displayName;
  screen_.warning = resolved_->state.staleBreak;
  if (resolved_->state.staleBreak) {
    screen_.detail = "Pausa abierta hace más de 25 min";
  } else if (resolved_->state.longShift) {
    screen_.detail = "Jornada de 4 h o más";
  } else {
    screen_.detail = "Elige una opción";
  }
  selectedActionDeadlineMs_ = nowMs + kActionSelectionMs;
  screen_.deadlineMs = selectedActionDeadlineMs_;
  screen_.busy = false;
  setActionButtons();
}

void AppController::openTimePicker(Command command, bool closesBreak,
                                   const AppEvent& event) {
  pickerCommand_ = command;
  pickerClosesBreak_ = closesBreak;
  screen_.kind = ScreenKind::TimePicker;
  screen_.title = closesBreak ? "¿A qué hora terminaste la pausa?"
                              : "¿A qué hora terminaste?";
  screen_.detail = "Mantén A/C para saltar 30 min";
  pickerMaxEpochSeconds_ = event.nowEpochSeconds;
  pickerMinEpochSeconds_ =
      parseRfc3339(resolved_->state.since).value_or(pickerMaxEpochSeconds_);
  if (pickerMinEpochSeconds_ < 0 ||
      pickerMinEpochSeconds_ > pickerMaxEpochSeconds_) {
    pickerMinEpochSeconds_ = pickerMaxEpochSeconds_;
  }
  screen_.selectedEpochSeconds = pickerMaxEpochSeconds_;
  screen_.buttons = {"−5 min", "Confirmar", "+5 min"};
  lastPickerPress_.reset();
  armInteractionDeadline(event.nowMs);
  screen_.warning = false;
}

void AppController::executeAction(Command command, const AppEvent& event,
                                  std::optional<int64_t> appliedEpoch,
                                  bool closeAfterBreak) {
  if (!resolved_.has_value() || currentUid_.empty() || terminalId_.empty() ||
      activeJobId_ != 0 || event.timestamp.empty() || clockSyncedAt_.empty()) {
    showMessage("No se puede preparar el fichaje; acerca de nuevo el tag.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }

  QueuedAction queued;
  queued.clientRequestId = makeRequestId(++sequence_);
  queued.uid = currentUid_;
  queued.command = command;
  queued.deviceCapturedAt = event.timestamp;
  queued.appliedAt = appliedEpoch.has_value() ? isoUtc(*appliedEpoch) : "";
  queued.clockSyncedAt = clockSyncedAt_;
  queued.deviceSequence = sequence_;
  queued.rebootId = config_.rebootId;
  queued.previousLocalHash = lastLocalHash_;
  queued.signature = signAction(
      deriveSigningKey(config_.credentials.terminalToken),
      canonicalAction(terminalId_, queued));

  const OutboxError appended = outbox_.append(queued);
  if (appended != OutboxError::None) {
    refreshPendingCount();
    showMessage(appended == OutboxError::Capacity
                    ? "Memoria llena; conecta la red."
                    : "No se pudo guardar el fichaje.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }
  lastLocalHash_ = queued.signature;
  refreshPendingCount();

  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Action;
  job.credentials = config_.credentials;
  job.action.clientRequestId = queued.clientRequestId;
  job.action.scanContext = resolved_->scanContext;
  job.action.command = queued.command;
  job.action.deviceCapturedAt = queued.deviceCapturedAt;
  job.action.appliedAt = queued.appliedAt;
  job.action.clockSyncedAt = queued.clockSyncedAt;
  job.action.deviceSequence = queued.deviceSequence;
  activeActionRequestId_ = queued.clientRequestId;
  activeActionCommand_ = command;
  activeActionClosesBreak_ = closeAfterBreak;
  if (!event.networkConnected || !worker_.enqueue(job)) {
    clearActiveActionTracking();
    showMessage("Guardado; se sincronizará", event.nowMs, kMessageMs);
    feedback_ = AppFeedback::Success;
    return;
  }
  activeJobId_ = job.id;
  screen_.kind = ScreenKind::Message;
  screen_.title = "Guardando fichaje";
  screen_.detail = "Esperando confirmación...";
  screen_.buttons = {};
  screen_.busy = true;
  screen_.deadlineMs = 0;
}

void AppController::handleActionResult(NetworkResult&& result,
                                       const AppEvent& event) {
  const std::string requestId =
      result.action != nullptr ? result.action->clientRequestId : "";
  // A malformed success cannot name the durable record. Keep it pending just
  // like a lost response; guessing which item to complete would lose data.
  if (result.call.ok &&
      (result.action == nullptr || requestId.empty() ||
       requestId != activeActionRequestId_)) {
    showMessage("Guardado; se sincronizará", event.nowMs, kMessageMs);
    clearActiveActionTracking();
    feedback_ = AppFeedback::Success;
    return;
  }

  if (!result.call.ok && ambiguous(result.call.failure)) {
    showMessage("Guardado; se sincronizará", event.nowMs, kMessageMs);
    clearActiveActionTracking();
    feedback_ = AppFeedback::Success;
    return;
  }

  // A definitive HTTP failure belongs to the one request serialized by this
  // controller. Never let a partially decoded error payload choose a different
  // durable record.
  const std::string completedId =
      result.call.ok ? requestId : activeActionRequestId_;
  const bool completionStored =
      !completedId.empty() && markActionComplete(completedId);

  if (!result.call.ok) {
    if (result.call.failure.authoritativeState.has_value()) {
      lastAuthoritativeState_ = *result.call.failure.authoritativeState;
      if (resolved_.has_value()) resolved_->state = lastAuthoritativeState_;
    }
    std::string message = result.call.failure.safeMessage.empty()
                              ? safeApiErrorMessage(result.call.failure.code)
                              : result.call.failure.safeMessage;
    if (message.empty()) message = "El fichaje fue rechazado.";
    if (!completionStored) message += " Pendiente de reconciliar.";
    showMessage(std::move(message), event.nowMs, kMessageMs, true);
    clearActiveActionTracking();
    feedback_ = AppFeedback::Error;
    return;
  }

  lastAuthoritativeState_ = result.action->state;
  if (resolved_.has_value()) resolved_->state = result.action->state;
  if (result.action->status == ActionStatus::Incident ||
      result.action->status == ActionStatus::Rejected) {
    const char* safe = safeApiErrorMessage(result.action->errorCode);
    std::string message =
        *safe == '\0' ? "Fichaje registrado con incidencia" : safe;
    if (!completionStored) message += " Pendiente de reconciliar.";
    showMessage(std::move(message), event.nowMs, kMessageMs, true);
    clearActiveActionTracking();
    feedback_ = AppFeedback::Error;
    return;
  }
  if (!completionStored) {
    showMessage("Registrado; pendiente de sincronizar", event.nowMs,
                kMessageMs);
    clearActiveActionTracking();
    feedback_ = AppFeedback::Success;
    return;
  }
  if (activeActionClosesBreak_) {
    clearActiveActionTracking();
    screen_.kind = ScreenKind::CloseConfirm;
    screen_.title = "¿Deseas cerrar ahora la jornada?";
    screen_.detail = "La pausa ya está cerrada";
    screen_.buttons = {"No", "", "Sí"};
    armInteractionDeadline(event.nowMs);
    screen_.busy = false;
    feedback_ = AppFeedback::Success;
    return;
  }
  showMessage(actionSuccessMessage(activeActionCommand_),
              event.nowMs, kSuccessMessageMs);
  clearActiveActionTracking();
  feedback_ = AppFeedback::Success;
}

void AppController::showMessage(std::string detail, uint32_t nowMs,
                                uint32_t durationMs, bool error) {
  screen_.kind = ScreenKind::Message;
  screen_.title = error ? "Atención" : "OpenJornada";
  screen_.detail = std::move(detail);
  screen_.buttons = {};
  screen_.deadlineMs = nowMs + durationMs;
  messageNextAtMs_ = screen_.deadlineMs;
  messageDeadlineActive_ = true;
  screen_.warning = error;
  screen_.busy = false;
}

void AppController::returnToIdle() {
  screen_.kind = ScreenKind::Idle;
  screen_.title = "OpenJornada";
  screen_.detail = "Acerca tu tarjeta";
  screen_.employee.clear();
  screen_.buttons = {};
  screen_.deadlineMs = 0;
  screen_.warning = false;
  screen_.busy = false;
  screen_.selectedEpochSeconds = 0;
  interactionDeadlineActive_ = false;
  messageDeadlineActive_ = false;
  resolveForClockOut_ = false;
  closeExpectedEmployeeId_.clear();
  resolved_.reset();
  currentUid_.clear();
  pickerClosesBreak_ = false;
  activeActionClosesBreak_ = false;
}

void AppController::refreshPendingCount() {
  size_t count = screen_.pendingCount;
  if (outbox_.pendingCount(count) == OutboxError::None) {
    screen_.pendingCount = count;
  }
}

bool AppController::markActionComplete(const std::string& clientRequestId) {
  const bool stored = outbox_.complete(clientRequestId) == OutboxError::None;
  refreshPendingCount();
  return stored;
}

void AppController::clearActiveActionTracking() {
  activeActionRequestId_.clear();
  activeActionClosesBreak_ = false;
}

void AppController::armInteractionDeadline(uint32_t nowMs) {
  interactionDeadlineActive_ = true;
  interactionDeadlineMs_ = nowMs + kInteractionInactivityMs;
  screen_.deadlineMs = interactionDeadlineMs_;
}

void AppController::setActionButtons() {
  screen_.buttons = {};
  const auto& state = resolved_->state;
  if (state.kind == WorkKind::Idle) {
    screen_.buttons.b = "Comenzar";
  } else if (state.kind == WorkKind::OnBreak) {
    screen_.buttons.a = "Fin pausa";
    screen_.buttons.c = "Acabar jornada";
  } else if (state.longShift) {
    screen_.buttons.a = "Pausa";
    screen_.buttons.b = "Terminar ahora";
    screen_.buttons.c = "Terminé antes";
  } else {
    screen_.buttons.a = "Pausa";
    screen_.buttons.c = "Terminar";
  }
}

std::string AppController::makeRequestId(uint32_t sequence) const {
  std::string prefix = config_.rebootId;
  if (prefix.size() > 48U) prefix.resize(48U);
  return prefix + "-" + std::to_string(sequence);
}

}  // namespace openjornada
