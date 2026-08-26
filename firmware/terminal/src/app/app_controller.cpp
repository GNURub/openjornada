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

constexpr char kAdminExitHint[] = "Mantén A+C 3 s para salir";

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
                             AppControllerConfig config,
                             CacheStore* cacheStore, ConfigStore* configStore)
    : worker_(worker),
      outbox_(outbox),
      cacheStore_(cacheStore),
      configStore_(configStore),
      config_(std::move(config)),
      cache_(config_.initialCache),
      clockTrust_(config_.lastNtpEpochSeconds),
      terminalId_(config_.terminalId),
      clockSyncedAt_(config_.clockSyncedAt) {
  if (config_.configFingerprint.empty()) {
    config_.configFingerprint = configurationFingerprint(
        config_.credentials.baseUrl, config_.credentials.terminalToken);
  }
  if ((!cache_.terminalId.empty() && cache_.terminalId != terminalId_) ||
      (!cache_.configFingerprint.empty() &&
       cache_.configFingerprint != config_.configFingerprint)) {
    cache_ = {};
  }
}

void AppController::start(size_t pendingCount, uint32_t nowMs) {
  clockTrust_.onBoot();
  monotonicMs_ = 0;
  lastObservedNowMs_ = nowMs;
  monotonicInitialized_ = true;
  started_ = true;
  screen_ = {};
  screen_.kind = ScreenKind::Boot;
  screen_.title = "OpenJornada";
  screen_.detail = "Conectando con el servidor...";
  screen_.pendingCount = pendingCount;
  if (!rehydratePending()) return;
  bootstrapRetryAtMs_ = nowMs;
  if (!terminalId_.empty() && !cache_.entries.empty()) returnToIdle();
}

void AppController::tick(const AppEvent& event) {
  if (!started_) return;
  observeMonotonic(event.nowMs);
  if (!outboxOperational_) return;
  updateStatus(event);
  processNetworkResults(event);
  if (!outboxOperational_) return;
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
  if (event.ntpTrusted &&
      (!clockTrust_.synchronizedThisBoot() ||
       event.ntpSyncEpochSeconds > clockTrust_.lastNtpEpochSeconds()) &&
      clockTrust_.onNtpSync(event.ntpSyncEpochSeconds)) {
    clockSyncedAt_ = isoUtc(event.ntpSyncEpochSeconds);
    persistRuntimeState();
  }
  screen_.ntpTrusted = clockTrust_.canCreateOffline(event.nowEpochSeconds);
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
  if (consumeAbandonedAdminJob(result.id)) {
    if ((result.kind == NetworkJobKind::AssignEmployee && result.call.ok) ||
        result.kind == NetworkJobKind::Cache) {
      cacheRefreshDone_ = false;
    }
    return;
  }
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
    const bool terminalChanged =
        !terminalId_.empty() && terminalId_ != result.bootstrap->terminal.id;
    terminalId_ = result.bootstrap->terminal.id;
    timezone_ = result.bootstrap->timezone;
    serverTimeEpochSeconds_ =
        parseRfc3339(result.bootstrap->serverTime).value_or(0);
    serverTimeObservedAtMonotonicMs_ = monotonicMs_;
    if (clockSyncedAt_.empty()) clockSyncedAt_ = result.bootstrap->serverTime;
    bootstrapReady_ = true;
    if (terminalChanged || cache_.terminalId != terminalId_ ||
        cache_.configFingerprint != config_.configFingerprint) {
      cache_ = {};
      if (cacheStore_ != nullptr) (void)cacheStore_->clear();
    }
    persistRuntimeState();
    enqueueCacheRefresh(event.nowMs);
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
    return;
  }
  if (result.kind == NetworkJobKind::Cache) {
    handleCacheResult(std::move(result), event);
    return;
  }
  if (result.kind == NetworkJobKind::Sync) {
    handleSyncResult(std::move(result), event);
    return;
  }
  if (result.kind == NetworkJobKind::OpenAdminSession) {
    if (adminFlow_.expire(event.nowMs, event.networkConnected)) {
      exitAdmin();
      return;
    }
    if (!result.call.ok || result.adminSession == nullptr ||
        !adminFlow_.setSession(result.adminSession->token, event.nowMs)) {
      const std::string message = result.call.failure.safeMessage.empty()
                                      ? "PIN no válido o sesión no disponible."
                                      : result.call.failure.safeMessage;
      adminFlow_.clearSession();
      showMessage(message, event.nowMs, kMessageMs, true);
      return;
    }
    enqueueEmployees(event);
    return;
  }
  if (result.kind == NetworkJobKind::Employees) {
    if (adminFlow_.expire(event.nowMs, event.networkConnected) ||
        !adminFlow_.canAdminister(event.networkConnected)) {
      exitAdmin();
      return;
    }
    if (!result.call.ok || result.employees == nullptr) {
      const std::string message = result.call.failure.safeMessage.empty()
                                      ? "No se pudo cargar el personal."
                                      : result.call.failure.safeMessage;
      showMessage(message, event.nowMs, kMessageMs, true);
      return;
    }
    adminEmployees_ = std::move(*result.employees);
    selectedEmployeeIndex_ = 0;
    showAdminEmployees();
    return;
  }
  if (result.kind == NetworkJobKind::AssignEmployee) {
    const bool sessionExpired =
        adminFlow_.expire(event.nowMs, event.networkConnected) ||
        !adminFlow_.canAdminister(event.networkConnected);
    if (sessionExpired) {
      pendingAdminUid_.clear();
      if (result.call.ok) cacheRefreshDone_ = false;
      exitAdmin();
      return;
    }
    if (!result.call.ok) {
      const std::string message = result.call.failure.safeMessage.empty()
                                      ? "No se pudo asignar el tag."
                                      : result.call.failure.safeMessage;
      pendingAdminUid_.clear();
      showMessage(message, event.nowMs, kMessageMs, true);
      return;
    }
    pendingAdminUid_.clear();
    if (selectedEmployeeIndex_ < adminEmployees_.itemCount) {
      adminEmployees_.items[selectedEmployeeIndex_].hasRfidTag = true;
    }
    cacheRefreshForAdmin_ = true;
    cacheRefreshDone_ = false;
    enqueueCacheRefresh(event.nowMs);
    return;
  }
  if (result.kind == NetworkJobKind::CloseAdminSession) {
    returnToIdle();
  }
}

void AppController::handleTimer(const AppEvent& event) {
  handleAdminTimer(event);
  if (!bootstrapReady_ && !bootstrapQueued_ && activeJobId_ == 0 &&
      event.networkConnected &&
      (bootstrapRetryAtMs_ == 0 ||
       deadlineReached(event.nowMs, bootstrapRetryAtMs_))) {
    enqueueBootstrap(event.nowMs);
  }
  if (bootstrapReady_ && !cacheRefreshDone_ && !cacheRefreshQueued_ &&
      activeJobId_ == 0 && event.networkConnected &&
      screen_.kind == ScreenKind::Idle) {
    enqueueCacheRefresh(event.nowMs);
  }
  if (bootstrapReady_ && cacheRefreshDone_ && !syncBlocked_ &&
      activeJobId_ == 0 && event.networkConnected &&
      screen_.kind == ScreenKind::Idle && screen_.pendingCount > 0 &&
      syncEngine_.ready(event.nowMs)) {
    enqueueSync(event);
  }
  if (screen_.kind == ScreenKind::Message && messageDeadlineActive_ &&
      deadlineReached(event.nowMs, messageNextAtMs_)) {
    messageDeadlineActive_ = false;
    if (bootstrapReady_ || (!terminalId_.empty() && !cache_.entries.empty())) {
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
  if (adminFlow_.modeActive() && !event.uid.empty()) {
    adminFlow_.touch(event.nowMs);
    if (screen_.kind != ScreenKind::AdminScan || activeJobId_ != 0) return;
    if (!adminFlow_.canAdminister(event.networkConnected) ||
        selectedEmployeeIndex_ >= adminEmployees_.itemCount) {
      adminFlow_.clearSession();
      showMessage("La sesión administrativa ha caducado.", event.nowMs,
                  kMessageMs, true);
      return;
    }
    pendingAdminUid_ = event.uid;
    if (adminEmployees_.items[selectedEmployeeIndex_].hasRfidTag) {
      screen_.kind = ScreenKind::AdminReplaceConfirm;
      screen_.title = "Sustituir tag";
      screen_.employee = kAdminExitHint;
      screen_.detail = "Esta persona ya tiene un tag asignado.";
      screen_.buttons = {"Cancelar", "", "Sustituir"};
      screen_.warning = true;
      return;
    }
    enqueueAssignment(event, false);
    return;
  }
  if (activeJobId_ != 0 || screen_.kind != ScreenKind::Idle ||
      event.uid.empty()) {
    return;
  }
  if (!event.networkConnected) {
    if (!clockTrust_.canCreateOffline(event.nowEpochSeconds)) {
      showMessage("Reloj no fiable; conecta la red.", event.nowMs,
                  kMessageMs, true);
      feedback_ = AppFeedback::Error;
      return;
    }
    auto cached = resolveFromCache(event.uid);
    if (!cached.has_value()) {
      showMessage("Tag no asignado; conecta la red.", event.nowMs,
                  kMessageMs, true);
      feedback_ = AppFeedback::Error;
      return;
    }
    currentUid_ = event.uid;
    resolved_ = std::move(*cached);
    resolvedOffline_ = true;
    lastAuthoritativeState_ = resolved_->state;
    showActions(event.nowMs);
    return;
  }
  if (!bootstrapReady_) {
    showMessage("Conectando con OpenJornada; inténtalo de nuevo.",
                event.nowMs, kMessageMs, true);
    return;
  }
  if (screen_.pendingCount > 0) {
    enqueueSync(event);
    return;
  }
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Resolve;
  job.credentials = config_.credentials;
  job.uid = event.uid;
  if (!worker_.enqueue(std::move(job))) {
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
  if (adminFlow_.modeActive()) adminFlow_.touch(event.nowMs);
  if (!held && screen_.kind == ScreenKind::AdminPin) {
    const auto pin = adminFlow_.updatePin(event.button, event.nowMs);
    screen_.detail = "PIN: " + adminFlow_.pinDisplay();
    if (pin.has_value()) enqueueAdminSession(*pin, event);
    return;
  }
  if (!held && screen_.kind == ScreenKind::AdminEmployees) {
    if (!adminFlow_.canAdminister(event.networkConnected) ||
        adminEmployees_.itemCount == 0) {
      adminFlow_.clearSession();
      showMessage("La sesión administrativa ha caducado.", event.nowMs,
                  kMessageMs, true);
      return;
    }
    adminFlow_.touch(event.nowMs);
    if (event.button == Button::A) {
      selectedEmployeeIndex_ =
          (selectedEmployeeIndex_ + adminEmployees_.itemCount - 1U) %
          adminEmployees_.itemCount;
      showAdminEmployees();
    } else if (event.button == Button::C) {
      selectedEmployeeIndex_ =
          (selectedEmployeeIndex_ + 1U) % adminEmployees_.itemCount;
      showAdminEmployees();
    } else {
      screen_.kind = ScreenKind::AdminScan;
      screen_.title = adminEmployees_.items[selectedEmployeeIndex_].displayName;
      screen_.employee = kAdminExitHint;
      screen_.detail = "Acerca el tag que deseas asignar.";
      screen_.buttons = {"Volver", "", ""};
      screen_.warning = false;
    }
    return;
  }
  if (!held && screen_.kind == ScreenKind::AdminScan) {
    if (event.button == Button::A) showAdminEmployees();
    return;
  }
  if (!held && screen_.kind == ScreenKind::AdminReplaceConfirm) {
    if (event.button == Button::A) {
      pendingAdminUid_.clear();
      showAdminEmployees();
    } else if (event.button == Button::C) {
      enqueueAssignment(event, true);
    }
    return;
  }
  if (held || activeJobId_ != 0) return;
  if (screen_.kind == ScreenKind::CloseConfirm) {
    if (event.button == Button::A) returnToIdle();
    if (event.button == Button::C) {
      if (closeBreakQueued_) {
        executeAction(Command::ClockOut, event);
      } else {
        enqueueCloseRefresh(event);
      }
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

void AppController::handleAdminTimer(const AppEvent& event) {
  if (adminFlow_.modeActive() &&
      (event.buttonADown || event.buttonBDown || event.buttonCDown)) {
    adminFlow_.touch(event.nowMs);
  }
  if (adminFlow_.holdCombo(event.buttonADown, event.buttonBDown,
                           event.buttonCDown, event.nowMs)) {
    if (adminFlow_.modeActive()) {
      exitAdmin();
    } else if (activeJobId_ == 0 && screen_.kind == ScreenKind::Idle) {
      if (!event.networkConnected) {
        showMessage("La administración necesita conexión.", event.nowMs,
                    kMessageMs, true);
      } else {
        openAdminPin(event.nowMs);
      }
    }
  }
  if (adminFlow_.expire(event.nowMs, event.networkConnected)) {
    exitAdmin();
  }
}

void AppController::openAdminPin(uint32_t nowMs) {
  adminFlow_.beginMode(nowMs);
  screen_.kind = ScreenKind::AdminPin;
  screen_.title = "Administración";
  screen_.employee = kAdminExitHint;
  screen_.detail = "PIN: " + adminFlow_.pinDisplay();
  screen_.buttons = {"−", "Confirmar", "+"};
  screen_.deadlineMs = nowMs + AdminFlow::kSessionIdleMs;
  screen_.warning = false;
  screen_.busy = false;
}

void AppController::enqueueAdminSession(const std::string& pin,
                                        const AppEvent& event) {
  if (!event.networkConnected || activeJobId_ != 0) {
    showMessage("La administración necesita conexión.", event.nowMs,
                kMessageMs, true);
    return;
  }
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::OpenAdminSession;
  job.credentials = config_.credentials;
  job.pin = pin;
  if (!worker_.enqueue(std::move(job))) {
    showMessage("El terminal está ocupado; inténtalo de nuevo.",
                event.nowMs, kMessageMs, true);
    return;
  }
  activeJobId_ = job.id;
  screen_.kind = ScreenKind::Message;
  screen_.title = "Administración";
  screen_.detail = "Comprobando PIN...";
  screen_.buttons = {};
  screen_.busy = true;
  screen_.deadlineMs = 0;
}

void AppController::enqueueEmployees(const AppEvent& event) {
  if (!adminFlow_.canAdminister(event.networkConnected)) {
    adminFlow_.clearSession();
    showMessage("La sesión administrativa ha caducado.", event.nowMs,
                kMessageMs, true);
    return;
  }
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Employees;
  job.credentials = config_.credentials;
  job.adminSession = adminFlow_.capability();
  if (!worker_.enqueue(std::move(job))) {
    showMessage("No se pudo solicitar la lista de personal.", event.nowMs,
                kMessageMs, true);
    return;
  }
  activeJobId_ = job.id;
  screen_.kind = ScreenKind::Message;
  screen_.title = "Administración";
  screen_.detail = "Cargando personal...";
  screen_.buttons = {};
  screen_.busy = true;
  screen_.deadlineMs = 0;
}

void AppController::enqueueAssignment(const AppEvent& event, bool replace) {
  if (!adminFlow_.canAdminister(event.networkConnected) ||
      selectedEmployeeIndex_ >= adminEmployees_.itemCount ||
      pendingAdminUid_.empty()) {
    showMessage("No se puede asignar el tag en este momento.", event.nowMs,
                kMessageMs, true);
    return;
  }
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::AssignEmployee;
  job.credentials = config_.credentials;
  job.adminSession = adminFlow_.capability();
  job.employeeId = adminEmployees_.items[selectedEmployeeIndex_].id;
  job.uid = pendingAdminUid_;
  job.replace = replace;
  if (!worker_.enqueue(std::move(job))) {
    showMessage("El terminal está ocupado; inténtalo de nuevo.",
                event.nowMs, kMessageMs, true);
    return;
  }
  activeJobId_ = job.id;
  screen_.kind = ScreenKind::Message;
  screen_.title = "Asignando tag";
  screen_.detail = "Esperando confirmación del servidor...";
  screen_.buttons = {};
  screen_.busy = true;
  screen_.deadlineMs = 0;
}

void AppController::exitAdmin() {
  const bool abandonedRequest = activeJobId_ != 0;
  adminFlow_.clearSession();
  pendingAdminUid_.clear();
  adminEmployees_ = {};
  cacheRefreshForAdmin_ = false;
  if (abandonedRequest) {
    rememberAbandonedAdminJob(activeJobId_);
    activeJobId_ = 0;
    if (cacheRefreshQueued_) cacheRefreshQueued_ = false;
  }
  // The worker is serialized: enqueueing server revocation here could delay a
  // normal RFID lookup by its full timeout. The RAM-only capability is erased
  // above and the server independently expires it after five minutes.
  returnToIdle();
}

void AppController::rememberAbandonedAdminJob(uint32_t id) {
  if (id == 0) return;
  for (uint32_t& candidate : abandonedAdminJobIds_) {
    if (candidate == 0 || candidate == id) {
      candidate = id;
      return;
    }
  }
}

bool AppController::consumeAbandonedAdminJob(uint32_t id) {
  for (uint32_t& candidate : abandonedAdminJobIds_) {
    if (candidate == id) {
      candidate = 0;
      return true;
    }
  }
  return false;
}

void AppController::showAdminEmployees() {
  screen_.kind = ScreenKind::AdminEmployees;
  screen_.title = "Asignar tag";
  screen_.employee = kAdminExitHint;
  if (adminEmployees_.itemCount == 0) {
    screen_.detail = "No hay personal disponible.";
    screen_.buttons = {};
  } else {
    const auto& employee = adminEmployees_.items[selectedEmployeeIndex_];
    screen_.detail = employee.displayName +
                     (employee.hasRfidTag ? " · tag asignado" : " · sin tag");
    screen_.buttons = {"Anterior", "Elegir", "Siguiente"};
  }
  screen_.warning = false;
  screen_.busy = false;
  screen_.deadlineMs = 0;
}

void AppController::enqueueBootstrap(uint32_t nowMs) {
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Bootstrap;
  job.credentials = config_.credentials;
  job.bootstrap = {kTerminalProtocolVersion, config_.clientVersion,
                   static_cast<uint32_t>(std::min<size_t>(
                       screen_.pendingCount, OutboxCodec::kCapacity))};
  if (!worker_.enqueue(std::move(job))) {
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

void AppController::enqueueCacheRefresh(uint32_t nowMs) {
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Cache;
  job.credentials = config_.credentials;
  job.cacheRevision = cache_.revision;
  if (!worker_.enqueue(std::move(job))) {
    cacheRefreshQueued_ = false;
    bootstrapRetryAtMs_ = nowMs + 2000U;
    return;
  }
  activeJobId_ = job.id;
  cacheRefreshQueued_ = true;
  screen_.kind = ScreenKind::Boot;
  screen_.title = "OpenJornada";
  screen_.detail = "Actualizando credenciales locales...";
  screen_.busy = true;
}

void AppController::enqueueSync(const AppEvent& event) {
  activeSyncBatch_.clear();
  const OutboxError listed = outbox_.list(activeSyncBatch_, kMaxApiSyncItems);
  if (listed != OutboxError::None || activeSyncBatch_.empty()) {
    if (listed != OutboxError::None) {
      failClosedOnOutbox();
    } else {
      if (!refreshPendingCount()) return;
      returnToIdle();
    }
    return;
  }
  NetworkJob job;
  job.id = nextJobId_++;
  job.kind = NetworkJobKind::Sync;
  job.credentials = config_.credentials;
  job.sync.actions = activeSyncBatch_;
  job.sync.pendingCount = static_cast<uint32_t>(screen_.pendingCount);
  if (!worker_.enqueue(std::move(job))) {
    syncEngine_.onTransportFailure(event.nowMs);
    activeSyncBatch_.clear();
    return;
  }
  activeJobId_ = job.id;
  screen_.kind = ScreenKind::Message;
  screen_.title = "Sincronizando";
  screen_.detail = "Enviando fichajes pendientes...";
  screen_.buttons = {};
  screen_.busy = true;
  screen_.deadlineMs = 0;
}

void AppController::handleCacheResult(NetworkResult&& result,
                                      const AppEvent& event) {
  cacheRefreshQueued_ = false;
  cacheRefreshDone_ = true;
  const bool adminSessionExpired =
      cacheRefreshForAdmin_ &&
      (adminFlow_.expire(event.nowMs, event.networkConnected) ||
       !adminFlow_.canAdminister(event.networkConnected));
  if (!result.call.ok || result.cache == nullptr) {
    if (cacheRefreshForAdmin_) {
      cacheRefreshForAdmin_ = false;
      if (adminSessionExpired) {
        exitAdmin();
      } else {
        showAdminEmployees();
      }
      return;
    }
    if (cache_.entries.empty()) {
      showMessage("No se pudo reconstruir la caché; se necesita red.",
                  event.nowMs, kMessageMs, true);
    } else {
      returnToIdle();
    }
    return;
  }
  if (!result.cache->unchanged) {
    CacheSnapshot candidate;
    candidate.revision = result.cache->revision;
    candidate.terminalId = terminalId_;
    candidate.configFingerprint = config_.configFingerprint;
    candidate.entries.reserve(result.cache->itemCount);
    for (size_t index = 0; index < result.cache->itemCount; ++index) {
      const CacheItem& item = result.cache->items[index];
      candidate.entries.push_back(
          {item.employeeId, item.displayName, item.uid,
           {item.state.kind, item.state.workedSeconds,
            item.state.breakSeconds, item.state.longShift,
            item.state.staleBreak}});
    }
    if (cacheStore_ != nullptr &&
        cacheStore_->replaceAtomically(candidate) != CacheError::None) {
      if (adminSessionExpired) {
        cacheRefreshForAdmin_ = false;
        exitAdmin();
      } else {
        showMessage("No se pudo guardar la caché actualizada.", event.nowMs,
                    kMessageMs, true);
      }
      return;
    }
    cache_ = std::move(candidate);
    if (!rehydratePending()) return;
  }
  if (cacheRefreshForAdmin_) {
    cacheRefreshForAdmin_ = false;
    if (adminSessionExpired) {
      exitAdmin();
    } else {
      showAdminEmployees();
    }
    return;
  }
  returnToIdle();
}

void AppController::handleSyncResult(NetworkResult&& result,
                                     const AppEvent& event) {
  const SyncResponse empty{};
  const SyncApplyResult applied = syncEngine_.applyResults(
      activeSyncBatch_, result.call,
      result.sync == nullptr ? empty : *result.sync);
  if (applied.status == SyncApplyStatus::Retry ||
      applied.status == SyncApplyStatus::Invalid) {
    syncEngine_.onTransportFailure(event.nowMs);
    activeSyncBatch_.clear();
    returnToIdle();
  }
  CacheSnapshot reconciled = cache_;
  const auto applyResultState = [&](size_t index) {
    if (result.sync == nullptr || index >= result.sync->itemCount ||
        index >= activeSyncBatch_.size()) {
      return false;
    }
    for (auto& entry : reconciled.entries) {
      if (entry.uid != activeSyncBatch_[index].uid) continue;
      const ApiWorkState& state = result.sync->items[index].state;
      entry.state = {state.kind, state.workedSeconds, state.breakSeconds,
                     state.longShift, state.staleBreak};
      return true;
    }
    // A full cache refresh is authoritative. If the UID is absent, there is
    // no local employee state left to reconcile before completing a
    // definitive server result.
    return true;
  };
  bool statesReady = true;
  for (size_t index = 0; index < applied.completedRequestIds.size(); ++index) {
    statesReady = applyResultState(index) && statesReady;
  }
  if (applied.status == SyncApplyStatus::Blocked && result.call.ok &&
      result.sync != nullptr &&
      applied.completedRequestIds.size() < result.sync->itemCount) {
    statesReady = applyResultState(applied.completedRequestIds.size()) &&
                  statesReady;
  }
  if (!result.call.ok && applied.status == SyncApplyStatus::Blocked) {
    reconciled.revision = 0;
    cacheRefreshDone_ = false;
  }
  if (statesReady && cacheStore_ != nullptr && !reconciled.entries.empty()) {
    statesReady =
        cacheStore_->replaceAtomically(reconciled) == CacheError::None;
  }
  if (!statesReady) {
    syncBlocked_ = true;
    activeSyncBatch_.clear();
    showMessage("No se pudo reconciliar la caché local; la cola se conserva.",
                event.nowMs, kMessageMs, true);
    return;
  }
  cache_ = std::move(reconciled);
  for (const auto& requestId : applied.completedRequestIds) {
    if (outbox_.complete(requestId) != OutboxError::None) {
      syncBlocked_ = true;
      activeSyncBatch_.clear();
      if (!refreshPendingCount()) return;
      showMessage("No se pudo confirmar la cola local.", event.nowMs,
                  kMessageMs, true);
      return;
    }
  }
  activeSyncBatch_.clear();
  if (!refreshPendingCount()) return;
  syncEngine_.onSuccess();
  if (applied.status == SyncApplyStatus::Blocked) {
    syncBlocked_ = true;
    showMessage("Un fichaje fue rechazado; revisa la incidencia.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }
  if (screen_.pendingCount == 0) {
    if (outbox_.compact() != OutboxError::None) {
      syncBlocked_ = true;
      showMessage("No se pudo compactar la cola local.", event.nowMs,
                  kMessageMs, true);
      return;
    }
    showMessage("Fichajes sincronizados", event.nowMs, kSuccessMessageMs);
  } else {
    returnToIdle();
  }
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
  if (!worker_.enqueue(std::move(job))) {
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

void AppController::showQueuedCloseConfirm(uint32_t nowMs) {
  closeBreakQueued_ = true;
  if (resolved_.has_value()) resolved_->state.kind = WorkKind::Working;
  screen_.kind = ScreenKind::CloseConfirm;
  screen_.title = "¿Deseas cerrar ahora la jornada?";
  screen_.detail = "El fin de pausa está pendiente de sincronizar";
  screen_.buttons = {"No", "", "Sí"};
  armInteractionDeadline(nowMs);
  screen_.busy = false;
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
  pickerMaxEpochSeconds_ = effectiveCapturedEpoch(event);
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
  const bool useServerClock =
      event.networkConnected &&
      (event.timestamp.empty() ||
       !clockTrust_.canCreateOffline(event.nowEpochSeconds));
  const int64_t capturedEpoch = effectiveCapturedEpoch(event);
  const std::string capturedAt =
      useServerClock ? isoUtc(capturedEpoch) : event.timestamp;
  if (!resolved_.has_value() || currentUid_.empty() || terminalId_.empty() ||
      activeJobId_ != 0 || capturedAt.empty() || clockSyncedAt_.empty()) {
    showMessage("No se puede preparar el fichaje; acerca de nuevo el tag.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }
  if ((resolvedOffline_ || !event.networkConnected) &&
      !clockTrust_.canCreateOffline(event.nowEpochSeconds)) {
    showMessage("Reloj no fiable; conecta la red.", event.nowMs,
                kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }

  QueuedAction queued;
  queued.clientRequestId = makeRequestId(++sequence_);
  queued.uid = currentUid_;
  queued.command = command;
  queued.deviceCapturedAt = capturedAt;
  queued.appliedAt = appliedEpoch.has_value() ? isoUtc(*appliedEpoch) : "";
  queued.clockSyncedAt = useServerClock ? capturedAt : clockSyncedAt_;
  queued.deviceSequence = sequence_;
  queued.rebootId = config_.rebootId;
  queued.previousLocalHash = lastLocalHash_;
  queued.signature = signAction(
      deriveSigningKey(config_.credentials.terminalToken),
      canonicalAction(terminalId_, queued));

  const OutboxError appended = outbox_.append(queued);
  if (appended != OutboxError::None) {
    if (!refreshPendingCount()) return;
    showMessage(appended == OutboxError::Capacity
                    ? "Memoria llena; conecta la red."
                    : "No se pudo guardar el fichaje.",
                event.nowMs, kMessageMs, true);
    feedback_ = AppFeedback::Error;
    return;
  }
  lastLocalHash_ = queued.signature;
  if (!refreshPendingCount()) return;
  (void)applyLocalAction(queued);

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
  if (closeBreakQueued_ || resolvedOffline_ || !event.networkConnected ||
      !worker_.enqueue(std::move(job))) {
    if (closeAfterBreak) {
      clearActiveActionTracking();
      showQueuedCloseConfirm(event.nowMs);
      feedback_ = AppFeedback::Success;
      return;
    }
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
    if (activeActionClosesBreak_) {
      showQueuedCloseConfirm(event.nowMs);
    } else {
      showMessage("Guardado; se sincronizará", event.nowMs, kMessageMs);
    }
    clearActiveActionTracking();
    feedback_ = AppFeedback::Success;
    return;
  }

  if (!result.call.ok && ambiguous(result.call.failure)) {
    if (activeActionClosesBreak_) {
      showQueuedCloseConfirm(event.nowMs);
    } else {
      showMessage("Guardado; se sincronizará", event.nowMs, kMessageMs);
    }
    clearActiveActionTracking();
    feedback_ = AppFeedback::Success;
    return;
  }

  if (!result.call.ok) {
    const bool hasAuthoritativeState =
        result.call.failure.authoritativeState.has_value();
    const ApiWorkState reconciled =
        hasAuthoritativeState ? *result.call.failure.authoritativeState
                              : lastAuthoritativeState_;
    if (!hasAuthoritativeState) {
      // A definitive rejection did not mutate server state. Persist the last
      // resolved state, then force a full cache response after this message.
      cache_.revision = 0;
      cacheRefreshDone_ = false;
    }
    const bool stateStored = updateCachedState(currentUid_, reconciled);
    const bool completionStored =
        stateStored && !activeActionRequestId_.empty() &&
        markActionComplete(activeActionRequestId_);
    if (!outboxOperational_) {
      clearActiveActionTracking();
      return;
    }
    lastAuthoritativeState_ = reconciled;
    if (resolved_.has_value()) resolved_->state = reconciled;
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

  const bool stateStored = updateCachedState(currentUid_, result.action->state);
  const bool completionStored =
      stateStored && !requestId.empty() && markActionComplete(requestId);
  if (!outboxOperational_) {
    clearActiveActionTracking();
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
    if (activeActionClosesBreak_) {
      showQueuedCloseConfirm(event.nowMs);
    } else {
      showMessage("Registrado; pendiente de sincronizar", event.nowMs,
                  kMessageMs);
    }
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
  if (!outboxOperational_) return;
  if (adminFlow_.modeActive()) {
    adminFlow_.clearSession();
    pendingAdminUid_.clear();
    adminEmployees_ = {};
    cacheRefreshForAdmin_ = false;
  }
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
  resolvedOffline_ = false;
  closeBreakQueued_ = false;
}

bool AppController::refreshPendingCount() {
  size_t count = 0;
  if (outbox_.pendingCount(count) != OutboxError::None) {
    failClosedOnOutbox();
    return false;
  }
  screen_.pendingCount = count;
  return true;
}

bool AppController::markActionComplete(const std::string& clientRequestId) {
  const bool stored = outbox_.complete(clientRequestId) == OutboxError::None;
  return refreshPendingCount() && stored;
}

bool AppController::applyLocalAction(const QueuedAction& action) {
  for (auto& entry : cache_.entries) {
    if (entry.uid != action.uid) continue;
    entry.state.kind = replayCommand(entry.state.kind, action.command);
    entry.state.longShift = entry.state.kind == WorkKind::Working &&
                            entry.state.workedSeconds >= 4 * 60 * 60;
    entry.state.staleBreak = entry.state.kind == WorkKind::OnBreak &&
                             entry.state.breakSeconds > 25 * 60;
    if (cacheStore_ != nullptr) {
      if (cacheStore_->replaceAtomically(cache_) != CacheError::None) {
        return false;
      }
    }
    if (resolved_.has_value() && currentUid_ == action.uid) {
      resolved_->state.kind = entry.state.kind;
    }
    return true;
  }
  return false;
}

bool AppController::updateCachedState(const std::string& uid,
                                      const ApiWorkState& state) {
  for (auto& entry : cache_.entries) {
    if (entry.uid != uid) continue;
    entry.state = {state.kind, state.workedSeconds, state.breakSeconds,
                   state.longShift, state.staleBreak};
    if (cacheStore_ != nullptr) {
      if (cacheStore_->replaceAtomically(cache_) != CacheError::None) {
        return false;
      }
    }
    return true;
  }
  if (!resolved_.has_value() || currentUid_ != uid ||
      resolved_->employee.id.empty() ||
      cache_.entries.size() >= CacheCodec::kCapacity) {
    return false;
  }
  cache_.terminalId = terminalId_;
  cache_.configFingerprint = config_.configFingerprint;
  cache_.entries.push_back(
      {resolved_->employee.id, resolved_->employee.displayName, uid,
       {state.kind, state.workedSeconds, state.breakSeconds, state.longShift,
        state.staleBreak}});
  return cacheStore_ == nullptr ||
         cacheStore_->replaceAtomically(cache_) == CacheError::None;
}

void AppController::observeMonotonic(uint32_t nowMs) {
  if (!monotonicInitialized_) {
    lastObservedNowMs_ = nowMs;
    monotonicInitialized_ = true;
    return;
  }
  monotonicMs_ += static_cast<uint32_t>(nowMs - lastObservedNowMs_);
  lastObservedNowMs_ = nowMs;
}

int64_t AppController::effectiveCapturedEpoch(const AppEvent& event) const {
  if (event.networkConnected && serverTimeEpochSeconds_ > 0 &&
      (event.timestamp.empty() ||
       !clockTrust_.canCreateOffline(event.nowEpochSeconds))) {
    const uint64_t elapsedMs =
        monotonicMs_ - serverTimeObservedAtMonotonicMs_;
    return serverTimeEpochSeconds_ + static_cast<int64_t>(elapsedMs / 1000U);
  }
  if (!event.timestamp.empty() && event.nowEpochSeconds > 0) {
    return event.nowEpochSeconds;
  }
  if (!event.networkConnected || serverTimeEpochSeconds_ <= 0) return 0;
  const uint64_t elapsedMs =
      monotonicMs_ - serverTimeObservedAtMonotonicMs_;
  return serverTimeEpochSeconds_ + static_cast<int64_t>(elapsedMs / 1000U);
}

void AppController::failClosedOnOutbox() {
  outboxOperational_ = false;
  syncBlocked_ = true;
  activeSyncBatch_.clear();
  clearActiveActionTracking();
  screen_.kind = ScreenKind::Fatal;
  screen_.title = "Cola local no disponible";
  screen_.detail =
      "No se aceptarán fichajes. Reinicia o usa la recuperación segura.";
  screen_.employee.clear();
  screen_.buttons = {};
  screen_.deadlineMs = 0;
  screen_.pendingCount = OutboxCodec::kCapacity;
  screen_.warning = true;
  screen_.busy = false;
  feedback_ = AppFeedback::Error;
}

void AppController::persistRuntimeState() {
  if (configStore_ == nullptr || terminalId_.empty() ||
      clockSyncedAt_.empty() || clockTrust_.lastNtpEpochSeconds() <= 0) {
    return;
  }
  (void)configStore_->saveRuntime(
      {terminalId_, clockSyncedAt_, config_.configFingerprint,
       clockTrust_.lastNtpEpochSeconds()});
}

bool AppController::rehydratePending() {
  CacheSnapshot candidate = cache_;
  std::string candidateLocalHash = lastLocalHash_;
  uint32_t candidateSequence = sequence_;
  const OutboxError replayed = outbox_.visitPending(
      [&](const QueuedAction& action) {
        if (action.rebootId == config_.rebootId) {
          candidateLocalHash = action.signature;
          candidateSequence =
              std::max(candidateSequence, action.deviceSequence);
        }
        for (auto& entry : candidate.entries) {
          if (entry.uid == action.uid) {
            entry.state.kind = replayCommand(entry.state.kind, action.command);
            break;
          }
        }
        return OutboxError::None;
      });
  if (replayed != OutboxError::None) {
    failClosedOnOutbox();
    return false;
  }
  if (cacheStore_ != nullptr && !candidate.entries.empty() &&
      cacheStore_->replaceAtomically(candidate) != CacheError::None) {
    failClosedOnOutbox();
    return false;
  }
  cache_ = std::move(candidate);
  lastLocalHash_ = std::move(candidateLocalHash);
  sequence_ = candidateSequence;
  return true;
}

std::optional<ResolveResponse> AppController::resolveFromCache(
    const std::string& uid) const {
  for (const auto& entry : cache_.entries) {
    if (entry.uid != uid) continue;
    ResolveResponse result;
    result.employee = {entry.employeeId, entry.displayName};
    result.state.kind = entry.state.kind;
    result.state.workedSeconds = entry.state.workedSeconds;
    result.state.breakSeconds = entry.state.breakSeconds;
    result.state.longShift = entry.state.longShift;
    result.state.staleBreak = entry.state.staleBreak;
    return result;
  }
  return std::nullopt;
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
