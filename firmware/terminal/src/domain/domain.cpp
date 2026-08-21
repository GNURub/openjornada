#include "openjornada/domain.hpp"

namespace openjornada {
namespace {

constexpr int64_t kOfflineClockTrustSeconds = 24 * 60 * 60;

}  // namespace

ButtonLabels visibleButtons(const WorkState& state) {
  switch (state.kind) {
    case WorkKind::Idle:
      return {nullptr, "Comenzar", nullptr};
    case WorkKind::OnBreak:
      return {"Fin pausa", nullptr, "Acabar"};
    case WorkKind::Working:
      if (state.longShift) {
        return {"Pausa", "Terminar", "Antes"};
      }
      return {"Pausa", nullptr, "Terminar"};
  }

  return {nullptr, nullptr, nullptr};
}

WorkKind nextKind(WorkKind current, Command command) {
  if (current == WorkKind::Idle && command == Command::ClockIn) {
    return WorkKind::Working;
  }
  if (current == WorkKind::Working && command == Command::BreakStart) {
    return WorkKind::OnBreak;
  }
  if (current == WorkKind::OnBreak && command == Command::BreakEnd) {
    return WorkKind::Working;
  }
  if (current == WorkKind::Working && command == Command::ClockOut) {
    return WorkKind::Idle;
  }
  return current;
}

int adjustedMinutes(int current, Button button, bool held) {
  const int step = held ? 30 : 5;
  if (button == Button::A) {
    return current - step;
  }
  if (button == Button::C) {
    return current + step;
  }
  return current;
}

bool offlineClockTrusted(int64_t syncedAt, int64_t now, bool rebooted) {
  if (syncedAt <= 0 || rebooted) {
    return false;
  }
  if (now <= syncedAt) {
    return true;
  }
  return now - syncedAt <= kOfflineClockTrustSeconds;
}

}  // namespace openjornada
